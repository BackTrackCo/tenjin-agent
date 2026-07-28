import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEdit, type EditArgs, type EditDeps } from './edit';
import { testSigner } from '../lib/read-test-utils';
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
        asOf: '2026-07-20T00:00:00Z',
        validUntil: '2026-08-20T00:00:00Z',
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
      expect(call.headers['x-tenjin-client']).toMatch(/^tenjin-cli\//);
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
    const { stub } = await edit({
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
    });
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
      'Answer card not lookup-eligible: State the exclusions (what this piece does not cover).',
    );
  });

  it('a card-less post shows as a browse-only document', async () => {
    const stub = stubServer({ get: { ...STORED, resource: undefined } });
    const res = await runEdit(
      args(),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect((res.humanLines ?? []).join('\n')).toContain('No answer card (browse-only document).');
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
    expect(out).toContain('lookup freshness gating uses it');
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

  it('renders a clear as (cleared) and reports a no-op edit honestly', async () => {
    const stub = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, clear: ['scope', 'questionsAnswered'] }),
      ctx,
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect(stderr()).toContain('scope: "L2 fees only" → (cleared)');
    expect(stderr()).toContain('questionsAnswered: 1 → 0 (cleared)');

    const noop = stubServer();
    const second = makeCtxCapturingStderr();
    await runEdit(
      args({ yes: true, title: 'The Answer' }),
      second.ctx,
      hermetic({ fetchImpl: noop.fetch, provider: spyProvider().provider }),
    );
    expect(second.stderr()).toContain('No field changes');
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
      'Answer card is lookup-eligible.',
      'warning: dropped external image ./pic.png',
    ]);
    // --json emits the full PUT response data.
    expect(res.data).toMatchObject({
      id: POST_ID,
      title: 'A Better Answer',
      warnings: ['dropped external image ./pic.png'],
    });
  });

  it('reports the missing rubric items when the card is still ineligible', async () => {
    const stub = stubServer();
    const res = await runEdit(
      args({ yes: true, scope: 'a new scope' }),
      makeCtx(),
      hermetic({ fetchImpl: stub.fetch, provider: spyProvider().provider }),
    );
    expect((res.humanLines ?? []).join('\n')).toContain(
      'Answer card not lookup-eligible: State the exclusions',
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
