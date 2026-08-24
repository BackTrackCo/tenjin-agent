import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEdit, type EditArgs, type EditDeps } from './edit';
import { testSigner } from '../lib/read-test-utils';
import { sessionPath } from '../lib/paths';
import type { WalletProvider, TenjinSigner } from '../lib/wallet';
import type { CommandContext } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-edit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** The stored post every test edits, card included (a snapshot, one question). */
const STORED = {
  id: POST_ID,
  creatorId: '0197cccc-bbbb-cccc-dddd-eeeeeeeeeeee',
  slug: 'the-answer',
  title: 'The Answer',
  status: 'published',
  price: '100000',
  url: 'https://preview.example/a/iris/the-answer',
  excerpt: 'A short stored excerpt.',
  bodyMd: '# The Answer\n\nThe stored body.\n',
  tags: [],
  resource: {
    artifactType: 'document',
    mediaType: 'text/markdown',
    temporalMode: 'snapshot',
    asOf: '2026-07-01T00:00:00Z',
    validUntil: null,
    supersedesPostId: null,
    questionsAnswered: ['What is it?'],
    tasksSupported: [],
    scope: 'L2 fees only',
    exclusions: null,
    appliesTo: { products: ['Base'] },
    provenanceSummary: null,
    methodologySummary: null,
    maintenanceCadence: null,
    reproductionMinutes: null,
    estimatedPaidInputCost: null,
    cacheEligible: false,
    cacheEligibleMissing: ['exclusions'],
    schemaVersion: 1,
  },
};

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: 'https://preview.example' },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** A ctx whose stderr writes are captured, for asserting notes + the summary. */
function makeCtxCapturingStderr(): { ctx: CommandContext; stderr: () => string } {
  const chunks: string[] = [];
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  const errStream = {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    stderr: () => chunks.join(''),
    ctx: {
      flags: { json: true, timeout: 5000, baseUrl: 'https://preview.example' },
      dataDir: dir,
      io: { stdout: sink(), stderr: errStream, isTTY: false },
    },
  };
}

function spyProvider(): { provider: WalletProvider; signCount: () => number } {
  const inner = testSigner();
  let n = 0;
  const signer: TenjinSigner = {
    address: inner.address,
    signMessage: (a) => {
      n++;
      return inner.signMessage(a);
    },
    signTypedData: (a) => inner.signTypedData(a),
    signTransaction: (tx) => inner.signTransaction(tx),
  };
  return {
    signCount: () => n,
    provider: {
      id: 'local',
      describe: async () => ({
        address: signer.address,
        provider: 'local',
        credentialSource: 'file',
        policyEnforcement: 'client-only',
      }),
      getSigner: async () => signer,
      diagnostics: async () => ({ warnings: [] }),
    },
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

interface StubOptions {
  /** Canned GET response body (default STORED) and status (default 200). */
  get?: Record<string, unknown>;
  getStatus?: number;
  getHeaders?: Record<string, string>;
  /** Canned PUT response body (default the GET body) and status (default 200). */
  put?: Record<string, unknown>;
  putStatus?: number;
  /** Per-attempt override: return a Response to short-circuit the canned one. */
  respond?: (call: Call, attempt: number) => Response | undefined;
}

function stubServer(opts: StubOptions = {}): {
  fetch: typeof fetch;
  calls: Call[];
  puts: () => Call[];
  putBody: () => Record<string, unknown> | undefined;
} {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers,
      ...(typeof init?.body === 'string'
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    };
    calls.push(call);
    const custom = opts.respond?.(call, calls.length);
    if (custom !== undefined) return custom;
    if (call.method === 'GET') {
      return json(opts.getStatus ?? 200, opts.get ?? STORED, opts.getHeaders);
    }
    return json(opts.putStatus ?? 200, opts.put ?? opts.get ?? STORED);
  }) as unknown as typeof fetch;
  const puts = (): Call[] => calls.filter((c) => c.method === 'PUT');
  return { fetch: fetchFn, calls, puts, putBody: () => puts()[0]?.body };
}

function json(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Hermetic deps: `auto` mode (edit has no --mode flag), a temp cwd, empty env. */
function hermetic(over: EditDeps = {}): EditDeps {
  return { env: { TENJIN_PUBLISH_MODE: 'auto' }, cwd: dir, ...over };
}

function args(over: Partial<EditArgs> = {}): EditArgs {
  return { postId: POST_ID, ...over };
}

async function writeDoc(content: string, name = 'body.md'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

/** Run an edit that is expected to succeed, returning the stub + result. */
async function edit(
  over: Partial<EditArgs>,
  stubOpts: StubOptions = {},
): Promise<{ stub: ReturnType<typeof stubServer>; data: Record<string, unknown> }> {
  const stub = stubServer(stubOpts);
  const { provider } = spyProvider();
  const res = await runEdit(
    args({ yes: true, ...over }),
    makeCtx(),
    hermetic({ fetchImpl: stub.fetch, provider }),
  );
  return { stub, data: res.data as Record<string, unknown> };
}

describe('runEdit — flag to body mapping', () => {
  it('every set flag lands on its documented PostUpdate key, and nothing else is sent', async () => {
    const { stub } = await edit({
      title: 'A Better Answer',
      price: '0.25',
      excerpt: 'A new excerpt.',
      question: ['What changed?'],
      task: ['estimate the fee'],
      scope: 'L2 execution fees',
      exclusions: 'L1 data fees',
      appliesTo: ['products=Vercel'],
      asOf: '2026-07-20T00:00:00Z',
      validUntil: '2026-08-20T00:00:00Z',
      artifactType: 'skill',
      temporalMode: 'maintained',
      provenance: 'measured on mainnet',
      methodology: 'ten samples, median',
    });
    expect(stub.putBody()).toEqual({
      title: 'A Better Answer',
      excerpt: 'A new excerpt.',
      price: '250000',
      resource: {
        artifactType: 'skill',
        temporalMode: 'maintained',
        // Sent canonicalized, so a re-run compares equal instead of re-writing.
        asOf: '2026-07-20T00:00:00.000Z',
        validUntil: '2026-08-20T00:00:00.000Z',
        questionsAnswered: ['What changed?'],
        tasksSupported: ['estimate the fee'],
        scope: 'L2 execution fees',
        exclusions: 'L1 data fees',
        appliesTo: { products: ['Vercel'] },
        provenanceSummary: 'measured on mainnet',
        methodologySummary: 'ten samples, median',
      },
    });
  });

  it('an omitted flag is ABSENT from the body (omitted key = the server keeps it)', async () => {
    const { stub } = await edit({ scope: 'only the scope moves' });
    expect(stub.putBody()).toEqual({ resource: { scope: 'only the scope moves' } });
    const body = stub.putBody() as Record<string, unknown>;
    expect('title' in body).toBe(false);
    expect('bodyMd' in body).toBe(false);
    expect('price' in body).toBe(false);
    expect('excerpt' in body).toBe(false);
    expect('status' in body).toBe(false);
    expect('tags' in body).toBe(false);
  });

  it('the PUT targets /api/posts/<id> and the GET precedes it', async () => {
    const { stub } = await edit({ title: 'Moved' });
    expect(stub.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    for (const call of stub.calls) {
      expect(call.url).toBe(`https://preview.example/api/posts/${POST_ID}`);
      expect(call.headers['user-agent']).toMatch(/^tenjin-cli\//);
      expect(call.headers['x-tenjin-client']).toBeUndefined();
    }
  });

  it('converts --price from decimal USD to atomic', async () => {
    const { stub } = await edit({ price: '1.5' });
    expect(stub.putBody()).toEqual({ price: '1500000' });
    await expect(
      runEdit(
        args({ yes: true, price: 'free' }),
        makeCtx(),
        hermetic({ fetchImpl: stubServer().fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });

  it('reads --body from the file and sends only the markdown below the frontmatter', async () => {
    const file = await writeDoc('---\ntitle: ignored\n---\n# New\n\nFresh body.\n');
    const { stub } = await edit({ body: file });
    expect(stub.putBody()).toEqual({ bodyMd: '# New\n\nFresh body.\n' });
  });
});

describe('runEdit — --clear', () => {
  it('clears nullable scalars with an explicit null and containers with []/{}', async () => {
    // A card with every clearable field SET, so every clear is a real change.
    const full = {
      ...STORED,
      resource: {
        ...STORED.resource,
        exclusions: 'L1 data fees',
        validUntil: '2026-09-01T00:00:00.000Z',
        supersedesPostId: '0197dddd-bbbb-cccc-dddd-eeeeeeeeeeee',
        provenanceSummary: 'measured',
        methodologySummary: 'median of ten',
        tasksSupported: ['estimate the fee'],
      },
    };
    const { stub } = await edit(
      {
        clear: [
          'scope',
          'exclusions',
          'asOf',
          'validUntil',
          'provenance',
          'methodology',
          'supersedesPostId',
          'questionsAnswered',
          'tasksSupported',
          'appliesTo',
        ],
      },
      { get: full },
    );
    expect(stub.putBody()).toEqual({
      resource: {
        scope: null,
        exclusions: null,
        asOf: null,
        validUntil: null,
        provenanceSummary: null,
        methodologySummary: null,
        supersedesPostId: null,
        questionsAnswered: [],
        tasksSupported: [],
        appliesTo: {},
      },
    });
  });

  it('drops a clear of a field that is already empty, rather than re-clearing it', async () => {
    // STORED already has exclusions/provenance/methodology/supersedesPostId null
    // and tasksSupported empty. Sending those keys anyway would count as a card
    // write server-side and re-run the embedding for a card nobody changed.
    const { stub } = await edit({
      clear: [
        'scope',
        'exclusions',
        'provenance',
        'methodology',
        'supersedesPostId',
        'tasksSupported',
      ],
    });
    expect(stub.putBody()).toEqual({ resource: { scope: null } });
  });

  it('combines a clear with a set on a different field', async () => {
    const { stub } = await edit({ clear: ['asOf'], scope: 'still scoped' });
    expect(stub.putBody()).toEqual({ resource: { scope: 'still scoped', asOf: null } });
  });

  it('an unknown field is USAGE and lists the valid names', async () => {
    const stub = stubServer();
    await expect(
      runEdit(
        args({ yes: true, clear: ['bodyMd'] }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({
      code: 'USAGE',
      exitCode: 2,
      fix: expect.stringContaining('questionsAnswered'),
    });
    expect(stub.calls).toHaveLength(0); // a flag typo costs no round trip
  });

  it('clearing and setting the same field in one run is USAGE', async () => {
    const stub = stubServer();
    const deps = hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider });
    const conflicts: Array<Partial<EditArgs>> = [
      { clear: ['scope'], scope: 'x' },
      { clear: ['asOf'], asOf: '2026-07-01T00:00:00Z' },
      { clear: ['questionsAnswered'], question: ['q'] },
      { clear: ['questionsAnswered'], addQuestion: ['q'] },
      { clear: ['tasksSupported'], task: ['t'] },
      { clear: ['appliesTo'], appliesTo: ['products=Base'] },
      { clear: ['provenance'], provenance: 'p' },
      { clear: ['methodology'], methodology: 'm' },
    ];
    for (const over of conflicts) {
      await expect(runEdit(args({ yes: true, ...over }), makeCtx(), deps)).rejects.toMatchObject({
        code: 'USAGE',
        exitCode: 2,
      });
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe('runEdit — empty values', () => {
  it('refuses an explicit empty string on any set flag and points at --clear', async () => {
    const stub = stubServer();
    const deps = hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider });
    for (const over of [
      { scope: '' },
      { exclusions: '  ' },
      { provenance: '' },
      { title: '' },
      { excerpt: '' },
      { question: [''] },
      { addTask: ['ok', ''] },
    ] as Array<Partial<EditArgs>>) {
      await expect(runEdit(args({ yes: true, ...over }), makeCtx(), deps)).rejects.toMatchObject({
        code: 'USAGE',
        exitCode: 2,
      });
    }
    await expect(runEdit(args({ yes: true, scope: '' }), makeCtx(), deps)).rejects.toMatchObject({
      fix: expect.stringContaining('--clear scope'),
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('runEdit — append convenience', () => {
  it('--add-question appends to the STORED array and sends the merged list', async () => {
    const { stub } = await edit({ addQuestion: ['How much does it cost?'] });
    expect(stub.putBody()).toEqual({
      resource: { questionsAnswered: ['What is it?', 'How much does it cost?'] },
    });
  });

  it('dedupes an exact-string repeat instead of sending it twice', async () => {
    const { stub } = await edit({ addQuestion: ['What is it?', 'A genuinely new one'] });
    expect(stub.putBody()).toEqual({
      resource: { questionsAnswered: ['What is it?', 'A genuinely new one'] },
    });
  });

  it('--add-task appends onto an empty stored array', async () => {
    const { stub } = await edit({ addTask: ['estimate the fee'] });
    expect(stub.putBody()).toEqual({ resource: { tasksSupported: ['estimate the fee'] } });
  });

  it('--question with --add-question (or --task with --add-task) is USAGE', async () => {
    const stub = stubServer();
    const deps = hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider });
    await expect(
      runEdit(args({ yes: true, question: ['a'], addQuestion: ['b'] }), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    await expect(
      runEdit(args({ yes: true, task: ['a'], addTask: ['b'] }), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(stub.calls).toHaveLength(0);
  });

  it('scans only the ADDED strings, never the stored ones it merges with', async () => {
    // The stored question carries a block-tier secret. It is already public and
    // no flag here can remove it, so blocking on it would trap the user behind a
    // secret they never typed. The append still goes through; the merged array
    // (secret included, because the server replaces arrays wholesale) is sent.
    const poisoned = {
      ...STORED,
      resource: {
        ...STORED.resource,
        questionsAnswered: ['How do I use AKIAIOSFODNN7EXAMPLE?'],
      },
    };
    const stub = stubServer({ get: poisoned });
    const res = await runEdit(
      args({ yes: true, addQuestion: ['What does it cost?'] }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(1);
    expect(stub.putBody()).toEqual({
      resource: {
        questionsAnswered: ['How do I use AKIAIOSFODNN7EXAMPLE?', 'What does it cost?'],
      },
    });
    expect((res.data as { id: string }).id).toBe(POST_ID);

    // Typing that same secret yourself still blocks: the gate moved scope, not away.
    const typed = stubServer();
    await expect(
      runEdit(
        args({ yes: true, addQuestion: ['How do I use AKIAIOSFODNN7EXAMPLE?'] }),
        makeCtx(),
        hermetic({ fetchImpl: typed.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    expect(typed.puts()).toHaveLength(0);
  });

  it('never leaks a server-owned key from the GET into the strictObject body', async () => {
    // The append path is the one place a stored card is read back; it must
    // contribute VALUES, never keys. cacheEligible / cacheEligibleMissing /
    // schemaVersion are server-owned and would be rejected by the strict body.
    const { stub } = await edit({ addQuestion: ['another'] });
    const resource = (stub.putBody() as { resource: Record<string, unknown> }).resource;
    expect(Object.keys(resource)).toEqual(['questionsAnswered']);
    for (const key of ['cacheEligible', 'cacheEligibleMissing', 'schemaVersion', 'mediaType']) {
      expect(key in resource).toBe(false);
    }
  });
});

describe('runEdit — show mode (no change flags)', () => {
  it('reads the post, prints it, and never writes', async () => {
    const stub = stubServer();
    const { provider } = spyProvider();
    const res = await runEdit(args(), makeCtx(), hermetic({ fetchImpl: stub.fetch, provider }));
    expect(stub.calls.map((c) => c.method)).toEqual(['GET']);
    expect(res.data).toEqual(STORED); // --json emits the full API response
    const human = (res.humanLines ?? []).join('\n');
    expect(human).toContain('The Answer (published), 0.1 USD (100000 atomic)');
    expect(human).toContain('url: https://preview.example/a/iris/the-answer');
    expect(human).toContain('questionsAnswered (1): What is it?');
    expect(human).toContain('scope: "L2 fees only"');
    expect(human).toContain(
      'Answer card incomplete, ranks below every complete card in agent search. To fix: State the exclusions (what this piece does not cover).',
    );
  });

  it('a card-less post says it ranks below every carded piece', async () => {
    const stub = stubServer({ get: { ...STORED, resource: undefined } });
    const res = await runEdit(
      args(),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect((res.humanLines ?? []).join('\n')).toContain(
      'No answer card: ranks below every carded piece in agent search.',
    );
  });

  it('--yes alone is still the read (no change flags means nothing to confirm)', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
  });
});

describe('runEdit — the confirmation gate', () => {
  it('review mode stops with NEEDS_CONFIRMATION (exit 3) and writes nothing', async () => {
    const stub = stubServer();
    await expect(
      runEdit(
        args({ scope: 'a new scope' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider, env: {} }),
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION', exitCode: 3 });
    expect(stub.puts()).toHaveLength(0);
  });

  it('the refusal payload carries the mode, the target, and the before/after summary', async () => {
    const stub = stubServer();
    try {
      await runEdit(
        args({ title: 'A Better Answer', price: '0.25', addQuestion: ['How much?'] }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider, env: {} }),
      );
      throw new Error('expected a throw');
    } catch (err) {
      const e = err as { code?: string; details?: Record<string, unknown> };
      expect(e.code).toBe('NEEDS_CONFIRMATION');
      const d = e.details as { mode: string; postId: string; title: string; changes: string[] };
      expect(d.mode).toBe('review');
      expect(d.postId).toBe(POST_ID);
      expect(d.title).toBe('The Answer');
      expect(d.changes).toEqual([
        'title: "The Answer" → "A Better Answer"',
        'price: 0.1 USD (100000 atomic) → 0.25 USD (250000 atomic)',
        'questionsAnswered: 1 → 2 (new: "How much?")',
      ]);
    }
  });

  it('--yes clears the review stop and the update goes through', async () => {
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider, env: {} }),
    );
    expect(stub.puts()).toHaveLength(1);
    expect((res.humanLines ?? [])[0]).toContain('Updated The Answer →');
  });

  it('auto mode proceeds on clean content and stops on a soft finding, like publish', async () => {
    const clean = stubServer();
    await runEdit(
      args({ scope: 'a clean new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: clean.fetch, provider: spyProvider().provider }),
    );
    expect(clean.puts()).toHaveLength(1);

    const soft = stubServer();
    await expect(
      runEdit(
        args({ provenance: `measured from 0x${'b'.repeat(40)}` }),
        makeCtx(),
        hermetic({ fetchImpl: soft.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(soft.puts()).toHaveLength(0);
  });

  it('explains the default mode once on stderr, and stays quiet when it is configured', async () => {
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider, env: {} }),
    );
    expect(stderr()).toContain('publish.mode: review (default) - each edit asks you once.');
    expect(stderr()).toContain('tenjin config set publish.mode auto');

    const configured = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, scope: 'another new scope' }),
      configured.ctx,
      hermetic({ fetchImpl: stubServer().fetch, provider: spyProvider().provider }),
    );
    expect(configured.stderr()).not.toContain('(default)');
  });

  it('warns instead of silently degrading on a mistyped TENJIN_PUBLISH_MODE', async () => {
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      ctx,
      hermetic({
        fetchImpl: stub.fetch,
        provider: spyProvider().provider,
        env: { TENJIN_PUBLISH_MODE: 'reveiw' },
      }),
    );
    expect(stderr()).toContain('Ignoring invalid TENJIN_PUBLISH_MODE="reveiw"');
  });

  it('a live secret in the new content hard-blocks in every mode, --yes included', async () => {
    for (const mode of ['auto', 'full-auto', 'review']) {
      const viaFlag = stubServer();
      await expect(
        runEdit(
          args({ yes: true, provenance: 'AKIAIOSFODNN7EXAMPLE' }),
          makeCtx(),
          hermetic({
            fetchImpl: viaFlag.fetch,
            provider: spyProvider().provider,
            env: { TENJIN_PUBLISH_MODE: mode },
          }),
        ),
      ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED', exitCode: 3 });
      expect(viaFlag.puts()).toHaveLength(0);
    }

    const viaBody = stubServer();
    const file = await writeDoc(`# T\n\nThe leaked key is 0x${'a'.repeat(64)}\n`);
    await expect(
      runEdit(
        args({ yes: true, body: file }),
        makeCtx(),
        hermetic({ fetchImpl: viaBody.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    expect(viaBody.puts()).toHaveLength(0);
  });
});

describe('runEdit — notes and the summary', () => {
  it('notes that frontmatter was ignored, the excerpt stays, and asOf did not move', async () => {
    const file = await writeDoc('---\ntitle: ignored\n---\n# New\n\nFresh body.\n');
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, body: file }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    const out = stderr();
    expect(out).toContain('frontmatter in the body file was ignored');
    expect(out).toContain('the excerpt stays as-is ("A short stored excerpt.")');
    expect(out).toContain('remains lexically indexed');
    expect(out).toContain('asOf is unchanged ("2026-07-01T00:00:00Z")');
    expect(out).toContain('search freshness gating uses it');
    expect(out).toContain('body: 31 → 19 characters');
  });

  it('a file with no frontmatter prints no frontmatter note', async () => {
    const file = await writeDoc('# New\n\nFresh body.\n');
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, body: file }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stderr()).not.toContain('frontmatter in the body file was ignored');
  });

  it('--body with --excerpt drops the excerpt warning; a maintained card drops the asOf nudge', async () => {
    const file = await writeDoc('# New\n\nFresh body.\n');
    const stub = stubServer({
      get: { ...STORED, resource: { ...STORED.resource, temporalMode: 'maintained' } },
    });
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, body: file, excerpt: 'A new excerpt.' }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stderr()).not.toContain('the excerpt stays as-is');
    expect(stderr()).not.toContain('asOf is unchanged');
  });

  it('renders a clear as (cleared)', async () => {
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, clear: ['scope', 'questionsAnswered'] }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stderr()).toContain('scope: "L2 fees only" → (cleared)');
    expect(stderr()).toContain('questionsAnswered: 1 → 0 (cleared)');
  });
});

describe('runEdit — a no-op edit writes nothing', () => {
  it('skips the PUT and reports no changes, in auto mode and with --yes', async () => {
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, title: STORED.title, price: '0.1', scope: STORED.resource.scope }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
    expect(stub.calls.map((c) => c.method)).toEqual(['GET']);
    expect(res.humanLines?.[0]).toContain('No changes');
    // The empty list is the machine signal that nothing was written.
    expect((res.data as { changes: string[] }).changes).toEqual([]);
    expect(res.data).toMatchObject({ id: POST_ID, title: STORED.title });
  });

  it('never reports a phantom change count, and never stops to confirm one', async () => {
    // review mode would otherwise ask before a write that changes nothing.
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    const res = await runEdit(
      args({ title: STORED.title }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider, env: {} }),
    );
    expect(stub.puts()).toHaveLength(0);
    expect((res.data as { changes: string[] }).changes).toEqual([]);
    expect(stderr()).not.toContain('change(s)');
  });

  it('an --add-question that only repeats a stored entry is a no-op', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true, addQuestion: ['What is it?'] }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
  });
});

describe('runEdit — the update receipt', () => {
  it('surfaces server warnings, the url, and the recomputed eligibility', async () => {
    const stub = stubServer({
      put: {
        ...STORED,
        title: 'A Better Answer',
        warnings: ['dropped external image ./pic.png'],
        resource: { ...STORED.resource, cacheEligible: true, cacheEligibleMissing: [] },
      },
    });
    const res = await runEdit(
      args({ yes: true, title: 'A Better Answer' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(res.humanLines).toEqual([
      'Updated A Better Answer → https://preview.example/a/iris/the-answer',
      'Answer card is search-eligible.',
      'warning: dropped external image ./pic.png',
    ]);
    // --json emits the full PUT response data.
    expect(res.data).toMatchObject({
      id: POST_ID,
      title: 'A Better Answer',
      warnings: ['dropped external image ./pic.png'],
    });
  });

  it('mirrors the change summary and notes into data, for a client with no stderr', async () => {
    // The MCP adapter hands the core a discard sink for stderr, so a summary that
    // lived only there would be one the client could never show the user.
    const file = await writeDoc('---\ntitle: ignored\n---\n# New\n\nA fresh body.\n');
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, body: file, title: 'A Better Answer' }),
      makeCtx(), // sink stderr, exactly like buildCtx() in the MCP server
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    const data = res.data as { changes: string[]; notes: string[] };
    expect(data.changes).toContain('title: "The Answer" → "A Better Answer"');
    expect(data.changes.some((c) => c.startsWith('body: '))).toBe(true);
    expect(data.notes.some((n) => n.includes('frontmatter in the body file was ignored'))).toBe(
      true,
    );
    expect(data.notes.some((n) => n.includes('the excerpt stays as-is'))).toBe(true);
  });

  it('omits notes when there are none, and always carries changes', async () => {
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect((res.data as { changes: string[] }).changes).toEqual([
      'scope: "L2 fees only" → "a new scope"',
    ]);
    expect('notes' in (res.data as object)).toBe(false);
  });

  it('reports the missing rubric items when the card is still ineligible', async () => {
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect((res.humanLines ?? []).join('\n')).toContain(
      'Answer card incomplete, ranks below every complete card in agent search. To fix: State the exclusions',
    );
  });
});

describe('runEdit — server failures', () => {
  it('maps a 404 on either verb to RESOURCE_NOT_FOUND without distinguishing "not yours"', async () => {
    const onGet = stubServer({ getStatus: 404, get: { error: { code: 'post_not_found' } } });
    await expect(
      runEdit(
        args({ yes: true, scope: 'x' }),
        makeCtx(),
        hermetic({ fetchImpl: onGet.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      message: expect.stringContaining('not yours'),
    });

    const onPut = stubServer({ putStatus: 404, put: { error: { code: 'post_not_found' } } });
    await expect(
      runEdit(
        args({ yes: true, scope: 'x' }),
        makeCtx(),
        hermetic({ fetchImpl: onPut.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('recovers a recoverable 401 on the GET and on the PUT (one re-sign each)', async () => {
    const expired = (): Response =>
      new Response(JSON.stringify({ error: { code: 'proof_expired' } }), {
        status: 401,
        headers: { 'www-authenticate': 'Session error="proof_expired"' },
      });
    const seen: string[] = [];
    const stub = stubServer({
      respond: (call) => {
        seen.push(call.method);
        const first = seen.filter((m) => m === call.method).length === 1;
        return first ? expired() : undefined;
      },
    });
    const res = await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(seen).toEqual(['GET', 'GET', 'PUT', 'PUT']);
    expect((res.data as { id: string }).id).toBe(POST_ID);
  });

  it('maps a 429 to RATE_LIMITED so an agent backs off', async () => {
    const stub = stubServer({ getStatus: 429, get: {} });
    await expect(
      runEdit(
        args({ yes: true, scope: 'x' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('names the rejected fields when the PUT fails validation (exit 4, after approval)', async () => {
    const stub = stubServer({
      putStatus: 400,
      put: {
        error: {
          code: 'validation_failed',
          message: 'validation failed',
          details: { fieldErrors: { 'resource.asOf': ['invalid'], title: ['too long'] } },
        },
      },
    });
    await expect(
      runEdit(
        args({ yes: true, scope: 'x' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
      exitCode: 4,
      message: expect.stringContaining('resource.asOf, title'),
    });
  });

  it('a bad post id is USAGE before any network or wallet touch', async () => {
    const stub = stubServer();
    const { provider, signCount } = spyProvider();
    await expect(
      runEdit(
        { postId: 'not-a-uuid', yes: true, scope: 'x' },
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(stub.calls).toHaveLength(0);
    expect(signCount()).toBe(0);
  });

  it('an out-of-bounds card value is USAGE before the write, with the dotted field key', async () => {
    const stub = stubServer();
    await expect(
      runEdit(
        args({ yes: true, asOf: 'yesterday' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({
      code: 'USAGE',
      details: { fieldErrors: { 'resource.asOf': expect.any(Array) } },
    });
    expect(stub.puts()).toHaveLength(0);
  });
});

describe('runEdit — session reuse', () => {
  it('the read and the write share one session (a single wallet signature)', async () => {
    const stub = stubServer();
    const { provider, signCount } = spyProvider();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider }),
    );
    expect(signCount()).toBe(1);
  });
});

describe('runEdit — the session is scoped to what the run does', () => {
  /** The scope of the delegation cached on disk, or null when none was minted. */
  async function cachedScope(): Promise<string | null> {
    try {
      const raw = await readFile(sessionPath(dir), 'utf8');
      return (JSON.parse(raw) as { scope?: string }).scope ?? null;
    } catch {
      return null;
    }
  }

  it('a no-flag show mints a read-scoped session, not a write-capable one', async () => {
    const stub = stubServer();
    const { provider, signCount } = spyProvider();
    await runEdit(args(), makeCtx(), hermetic({ fetchImpl: stub.fetch, provider }));
    expect(await cachedScope()).toBe('read');
    expect(signCount()).toBe(1);
  });

  it('an invocation that intends to write mints read+write', async () => {
    const stub = stubServer();
    const { provider } = spyProvider();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider }),
    );
    expect(await cachedScope()).toBe('read+write');
  });

  it('a cached read+write session serves a later show with no new signature', async () => {
    const { provider, signCount } = spyProvider();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stubServer().fetch, provider }),
    );
    expect(signCount()).toBe(1);

    await runEdit(args(), makeCtx(), hermetic({ fetchImpl: stubServer().fetch, provider }));
    expect(signCount()).toBe(1); // wider covers narrower: no second popup
    expect(await cachedScope()).toBe('read+write'); // and never rebuilt downward
  });

  it('a cached read session re-establishes before a write, rather than being refused', async () => {
    const { provider, signCount } = spyProvider();
    await runEdit(args(), makeCtx(), hermetic({ fetchImpl: stubServer().fetch, provider }));
    expect(signCount()).toBe(1);
    expect(await cachedScope()).toBe('read');

    const write = stubServer();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: write.fetch, provider }),
    );
    // The read-scoped delegation cannot carry a write (the server answers
    // insufficient_scope), so the write run pays for one more signature.
    expect(signCount()).toBe(2);
    expect(await cachedScope()).toBe('read+write');
    expect(write.puts()).toHaveLength(1);
  });
});

describe('runEdit — every typed source faces the scan', () => {
  // A live-shaped AWS key: block tier, never clearable by --yes or any mode.
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';
  const cases: Array<[string, Partial<EditArgs>]> = [
    ['title', { title: SECRET }],
    ['excerpt', { excerpt: SECRET }],
    ['scope', { scope: SECRET }],
    ['exclusions', { exclusions: SECRET }],
    ['provenance', { provenance: SECRET }],
    ['methodology', { methodology: SECRET }],
    ['question', { question: [SECRET] }],
    ['task', { task: [SECRET] }],
    ['add-question', { addQuestion: [SECRET] }],
    ['add-task', { addTask: [SECRET] }],
    ['applies-to', { appliesTo: [`products=${SECRET}`] }],
  ];

  it.each(cases)('a secret in --%s hard-blocks and writes nothing', async (_label, over) => {
    const stub = stubServer();
    await expect(
      runEdit(
        args({ yes: true, ...over }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED', exitCode: 3 });
    expect(stub.puts()).toHaveLength(0);
  });

  it('the ISO fields cannot carry a secret at all: they fail validation first', async () => {
    // --as-of / --valid-until are in the scanned set for symmetry, but an
    // ISO-8601 check rejects anything secret-shaped before the scan sees it, so
    // USAGE (exit 2) is the honest outcome to pin, not a block.
    const stub = stubServer();
    for (const over of [{ asOf: SECRET }, { validUntil: SECRET }]) {
      await expect(
        runEdit(
          args({ yes: true, ...over }),
          makeCtx(),
          hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
        ),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    }
    expect(stub.puts()).toHaveLength(0);
  });
});

describe('runEdit — appliesTo is compared as a value, not a key count', () => {
  it('re-sending the stored pair writes nothing', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true, appliesTo: ['products=Base'] }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
  });

  it('detects a same-size value swap and renders the values, not the counts', async () => {
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, appliesTo: ['products=Vercel'] }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.putBody()).toEqual({ resource: { appliesTo: { products: ['Vercel'] } } });
    expect(stderr()).toContain('appliesTo: products=Base → products=Vercel');
  });

  it('detects a reordered value list (order is meaning for a replace)', async () => {
    const stub = stubServer({
      get: {
        ...STORED,
        resource: { ...STORED.resource, appliesTo: { products: ['Base', 'Vercel'] } },
      },
    });
    await runEdit(
      args({ yes: true, appliesTo: ['products=Vercel', 'products=Base'] }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.putBody()).toEqual({
      resource: { appliesTo: { products: ['Vercel', 'Base'] } },
    });
  });
});

describe('runEdit — a post with no answer card', () => {
  const CARDLESS = { ...STORED, resource: undefined };

  it('clearing a card field writes nothing (there is no card to clear)', async () => {
    const stub = stubServer({ get: CARDLESS });
    const res = await runEdit(
      args({ yes: true, clear: ['scope', 'questionsAnswered', 'appliesTo'] }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
    expect((res.data as { changes: string[] }).changes).toEqual([]);
  });

  it('omits resource entirely when a real post change rides alongside a clear', async () => {
    // Any resource key at all mints an all-default card row server-side, turning a
    // card-less post into a card-bearing one. The title must travel alone.
    const stub = stubServer({ get: CARDLESS });
    await runEdit(
      args({ yes: true, clear: ['scope'], title: 'A Better Answer' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.putBody()).toEqual({ title: 'A Better Answer' });
  });

  it('still lets a genuine card field CREATE the card', async () => {
    const stub = stubServer({ get: CARDLESS });
    await runEdit(
      args({ yes: true, scope: 'L2 fees only' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.putBody()).toEqual({ resource: { scope: 'L2 fees only' } });
  });
});

describe('runEdit — normalization keeps an edit idempotent', () => {
  it('a timestamp that differs only in spelling is not a change', async () => {
    // The server echoes timestamptz through toISOString(); a flag carries whatever
    // the user typed. Same instant, two spellings: re-writing it forever is the bug.
    const stub = stubServer();
    await runEdit(
      args({ yes: true, asOf: '2026-07-01T00:00:00.000Z' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);

    // And the same instant written with an offset instead of Z.
    const offset = stubServer();
    await runEdit(
      args({ yes: true, asOf: '2026-06-30T20:00:00-04:00' }),
      makeCtx(),
      hermetic({ fetchImpl: offset.fetch, provider: spyProvider().provider }),
    );
    expect(offset.puts()).toHaveLength(0);
  });

  it('an excerpt that differs only in surrounding whitespace is not a change', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true, excerpt: `  ${STORED.excerpt}  ` }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
  });

  it('a title that differs only in surrounding whitespace is not a change', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true, title: `  ${STORED.title}  ` }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
  });

  it('a real timestamp move IS sent, canonicalized', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true, asOf: '2026-07-20T00:00:00Z' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.putBody()).toEqual({ resource: { asOf: '2026-07-20T00:00:00.000Z' } });
  });
});

describe('runEdit — the scan follows what ships, not what was typed', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';
  /** A post whose STORED, already-public text is secret-shaped. */
  const POISONED = {
    ...STORED,
    resource: { ...STORED.resource, scope: `see ${SECRET} for the key` },
  };

  it('a pruned value cannot block an unrelated change', async () => {
    // Restating the stored scope verbatim alongside a real title change: the scope
    // prunes away, only the title ships, so there is nothing new to refuse. The
    // secret is already public and no flag here could remove it, and the same flags
    // WITHOUT --title exit 0, so blocking would be incoherent as well as unhelpful.
    const stub = stubServer({ get: POISONED });
    const res = await runEdit(
      args({ yes: true, scope: `see ${SECRET} for the key`, title: 'A Better Answer' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.putBody()).toEqual({ title: 'A Better Answer' });
    expect((res.data as { id: string }).id).toBe(POST_ID);
  });

  it('the same flags with nothing surviving are a no-op, not a block', async () => {
    const stub = stubServer({ get: POISONED });
    const res = await runEdit(
      args({ yes: true, scope: `see ${SECRET} for the key` }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
    expect((res.data as { changes: string[] }).changes).toEqual([]);
  });

  it('a secret in a SURVIVING value still blocks', async () => {
    const stub = stubServer({ get: POISONED });
    await expect(
      runEdit(
        args({ yes: true, scope: `now also ${SECRET} plus more`, title: 'A Better Answer' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    expect(stub.puts()).toHaveLength(0);
  });

  it('a body file that prunes to a no-op does not block on its stored secret', async () => {
    const body = `# The Answer\n\nThe key is ${SECRET}\n`;
    const stored = { ...STORED, bodyMd: body };
    const file = await writeDoc(body);
    const stub = stubServer({ get: stored });
    const res = await runEdit(
      args({ yes: true, body: file }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(0);
    expect((res.data as { changes: string[] }).changes).toEqual([]);
  });

  it('a body file that DOES change still blocks on a secret it introduces', async () => {
    const file = await writeDoc(`# The Answer\n\nA new body with ${SECRET} in it.\n`);
    const stub = stubServer();
    await expect(
      runEdit(
        args({ yes: true, body: file }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    expect(stub.puts()).toHaveLength(0);
  });
});

describe('runEdit — the delegation on the wire', () => {
  /** The SIWX resources bound into the delegation header of the first request. */
  function delegationResourcesOf(call: { headers: Record<string, string> }): string[] {
    const header = call.headers['tenjin-session-delegation'];
    expect(header, 'the request carried no session delegation').toBeDefined();
    const decoded = Buffer.from(header as string, 'base64').toString('utf8');
    return (JSON.parse(decoded) as { resources?: string[] }).resources ?? [];
  }

  it('a no-flag show binds scope:read into the signed delegation itself', async () => {
    // The scope on disk and the scope on the wire come from the same variable, so
    // pinning session.json alone would survive a hardcoded 'read+write' here.
    const stub = stubServer();
    await runEdit(
      args(),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(delegationResourcesOf(stub.calls[0]!)).toContain('urn:tenjin:session:scope:read');
  });

  it('a change run binds scope:read+write', async () => {
    const stub = stubServer();
    await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(delegationResourcesOf(stub.calls[0]!)).toContain('urn:tenjin:session:scope:read+write');
  });
});

describe('runEdit — the receipt echoes the mode that was actually used', () => {
  it('carries the resolved mode, so a per-run override is visible', async () => {
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect((res.data as { mode: string }).mode).toBe('auto');

    const override = stubServer();
    const res2 = await runEdit(
      args({ yes: true, scope: 'another new scope', mode: 'full-auto' }),
      makeCtx(),
      hermetic({ fetchImpl: override.fetch, provider: spyProvider().provider, env: {} }),
    );
    expect((res2.data as { mode: string }).mode).toBe('full-auto');
  });

  it('--mode loosens the gate for one run: a warn finding proceeds without --yes', async () => {
    const stub = stubServer();
    await runEdit(
      args({ provenance: `measured from 0x${'b'.repeat(40)}`, mode: 'full-auto' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider, env: {} }),
    );
    expect(stub.puts()).toHaveLength(1);
  });

  it('a mistyped --mode is USAGE before any wallet or network work', async () => {
    const stub = stubServer();
    const { provider, signCount } = spyProvider();
    await expect(
      runEdit(
        args({ yes: true, scope: 'x', mode: 'Review' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(stub.calls).toHaveLength(0);
    expect(signCount()).toBe(0);
  });
});

describe('runEdit — the notes never contradict the summary', () => {
  it('clearing asOf drops the "asOf is unchanged" note', async () => {
    const file = await writeDoc('# New\n\nA fresh body.\n');
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, body: file, clear: ['asOf'] }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    const out = stderr();
    expect(out).toContain('asOf: "2026-07-01T00:00:00.000Z" → (cleared)');
    expect(out).not.toContain('asOf is unchanged');
  });

  it('keeps the note when asOf really is staying put', async () => {
    const file = await writeDoc('# New\n\nA fresh body.\n');
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, body: file }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stderr()).toContain('asOf is unchanged');
  });
});

describe('runEdit — a big appliesTo cannot flood one line', () => {
  it('caps each value and the whole rendering', async () => {
    const long = 'v'.repeat(120);
    const stub = stubServer({
      get: {
        ...STORED,
        resource: {
          ...STORED.resource,
          appliesTo: Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [
              `key${i}`,
              Array.from({ length: 20 }, () => long),
            ]),
          ),
        },
      },
    });
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, appliesTo: ['products=Base'] }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    const line = stderr()
      .split('\n')
      .find((l) => l.startsWith('appliesTo: '));
    expect(line).toBeDefined();
    // 19KB of card would otherwise land on this one line.
    expect((line as string).length).toBeLessThan(500);
    expect(line).toContain('…');
  });
});

describe('runEdit — the project-marker scan context (parity with publish)', () => {
  /** A git checkout whose remote names an org/repo the scan treats as private. */
  async function gitProject(): Promise<void> {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(
      join(dir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:AcmeInternal/secret-service.git\n',
      'utf8',
    );
  }

  it('warns when a card field quotes the source project, so auto mode stops to ask', async () => {
    // Publish gained this context in #38; an edit ships to the same public card, so
    // it must derive the same markers or the two gates have quietly diverged.
    await gitProject();
    const stub = stubServer();
    await expect(
      runEdit(
        args({ scope: 'internals of AcmeInternal/secret-service' }),
        makeCtx(),
        hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(stub.puts()).toHaveLength(0);
  });

  it('is warn-tier, so --yes still applies it', async () => {
    await gitProject();
    const stub = stubServer();
    await runEdit(
      args({ yes: true, scope: 'internals of AcmeInternal/secret-service' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(1);
  });

  it('says nothing when the text does not name the project', async () => {
    await gitProject();
    const stub = stubServer();
    await runEdit(
      args({ scope: 'a new scope naming nothing private' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stub.puts()).toHaveLength(1); // auto mode, clean scan: applied
  });

  it("a body file draws its markers from the FILE's project, not the cwd", async () => {
    // The body may come from anywhere; the project that matters is the one the
    // draft lives in, matching publish's resolution.
    const other = await mkdtemp(join(tmpdir(), 'tenjin-edit-src-'));
    try {
      await mkdir(join(other, '.git'), { recursive: true });
      await writeFile(
        join(other, '.git', 'config'),
        '[remote "origin"]\n\turl = https://github.com/OtherOrg/other-repo.git\n',
        'utf8',
      );
      const file = join(other, 'body.md');
      await writeFile(file, '# New\n\nNotes on OtherOrg/other-repo internals.\n', 'utf8');
      const stub = stubServer();
      await expect(
        runEdit(
          args({ body: file }),
          makeCtx(),
          hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
        ),
      ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
      expect(stub.puts()).toHaveLength(0);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
