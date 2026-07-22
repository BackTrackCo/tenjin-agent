import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublish, type PublishArgs, type PublishDeps } from './publish';
import { createCandidate, readCandidate } from '../lib/candidate-store';
import { testSigner } from '../lib/read-test-utils';
import type { WalletProvider, TenjinSigner } from '../lib/wallet';
import type { CommandContext } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-publish-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: 'https://preview.example' },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** A ctx whose stderr writes are captured, for asserting the default-mode notice. */
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

/** A spy wallet provider counting wallet signatures (the establish popup). */
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

const CREATED = {
  id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  slug: 'the-answer',
  title: 'The Answer',
  status: 'published',
  price: '100000',
  url: 'https://preview.example/a/iris/the-answer',
  tags: [],
};

function stubServer(post: Record<string, unknown> = CREATED): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

async function writeDoc(content: string): Promise<string> {
  const path = join(dir, 'post.md');
  await writeFile(path, content, 'utf8');
  return path;
}

const CLEAN = '# The Answer\n\nA plain body with nothing sensitive.\n';
const WARN = '# The Answer\n\nSend to 0x' + 'b'.repeat(40) + ' today.\n';
// A bare, uncontextualized 0x-64-hex raw private key: a hard block in every mode,
// and it stays a block through B3.1's secret-assignment→warn demotion.
const BLOCK = '# The Answer\n\nThe leaked key is 0x' + 'a'.repeat(64) + '\n';

function baseArgs(file: string | undefined, over: Partial<PublishArgs> = {}): PublishArgs {
  return { ...(file !== undefined ? { file } : {}), ...over };
}

/** Hermetic deps: an empty env and a temp cwd so tests never read the ambient
 *  process.env (TENJIN_PUBLISH_MODE / TENJIN_NO_SESSION) or a stray .tenjin.json. */
function hermetic(over: PublishDeps = {}): PublishDeps {
  return { env: {}, cwd: dir, ...over };
}

describe('runPublish — consent matrix (mode × content × --yes)', () => {
  type Outcome = 'success' | 'NEEDS_CONFIRMATION' | 'PUBLISH_BLOCKED';
  const cases: Array<{ mode: string; content: string; yes: boolean; want: Outcome }> = [
    { mode: 'auto', content: CLEAN, yes: false, want: 'success' },
    { mode: 'auto', content: CLEAN, yes: true, want: 'success' },
    { mode: 'auto', content: WARN, yes: false, want: 'NEEDS_CONFIRMATION' },
    { mode: 'auto', content: WARN, yes: true, want: 'success' },
    { mode: 'review', content: CLEAN, yes: false, want: 'NEEDS_CONFIRMATION' },
    { mode: 'review', content: CLEAN, yes: true, want: 'success' },
    { mode: 'review', content: WARN, yes: false, want: 'NEEDS_CONFIRMATION' },
    { mode: 'review', content: WARN, yes: true, want: 'success' },
    { mode: 'full-auto', content: WARN, yes: false, want: 'success' },
    { mode: 'full-auto', content: CLEAN, yes: false, want: 'success' },
    { mode: 'auto', content: BLOCK, yes: true, want: 'PUBLISH_BLOCKED' },
    { mode: 'full-auto', content: BLOCK, yes: true, want: 'PUBLISH_BLOCKED' },
    { mode: 'review', content: BLOCK, yes: false, want: 'PUBLISH_BLOCKED' },
  ];

  for (const c of cases) {
    it(`${c.mode} × ${label(c.content)} × yes=${c.yes} → ${c.want}`, async () => {
      const file = await writeDoc(c.content);
      const { fetch, calls } = stubServer();
      const { provider, signCount } = spyProvider();
      const deps = hermetic({ fetchImpl: fetch, provider });
      const args = baseArgs(file, { mode: c.mode, ...(c.yes ? { yes: true } : {}) });

      if (c.want === 'success') {
        const res = await runPublish(args, makeCtx(), deps);
        expect((res.data as { resourceId: string }).resourceId).toBe(CREATED.id);
        expect(calls).toHaveLength(1);
      } else {
        await expect(runPublish(args, makeCtx(), deps)).rejects.toMatchObject({ code: c.want });
        expect(calls).toHaveLength(0); // a refused publish never writes
        // And never touches the wallet: consent gates BEFORE the session establish
        // that would call signMessage. A regression moving establish above the gate
        // would flip this from 0.
        expect(signCount()).toBe(0);
      }
    });
  }
});

function label(content: string): string {
  return content === CLEAN ? 'clean' : content === WARN ? 'warn' : 'block';
}

describe('runPublish — exit-code conformance', () => {
  it('PUBLISH_BLOCKED and NEEDS_CONFIRMATION are exit 3, unreadable file is exit 2', async () => {
    const { provider } = spyProvider();
    const { fetch } = stubServer();
    const deps = hermetic({ fetchImpl: fetch, provider });
    await expect(
      runPublish(baseArgs(await writeDoc(BLOCK)), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED', exitCode: 3 });
    await expect(
      runPublish(baseArgs(await writeDoc(CLEAN), { mode: 'review' }), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION', exitCode: 3 });
    await expect(
      runPublish(baseArgs(join(dir, 'missing.md')), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });
});

describe('runPublish — receipt + card echo', () => {
  it('returns a compact receipt with the server cacheEligible + mapped missing sentences', async () => {
    const file = await writeDoc(
      ['---', 'title: The Answer', 'questionsAnswered:', '  - What is it?', '---', 'body'].join(
        '\n',
      ),
    );
    const { fetch } = stubServer({
      ...CREATED,
      resource: { cacheEligible: false, cacheEligibleMissing: ['scope', 'exclusions'] },
    });
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(file, { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect(res.data).toMatchObject({
      resourceId: CREATED.id,
      url: CREATED.url,
      status: 'published',
      price: { atomic: '100000', usd: '0.1' },
      cacheEligible: false,
      missing: [
        'Describe the scope (what this piece covers).',
        'State the exclusions (what this piece does not cover).',
      ],
      deskUrl: 'https://preview.example/desk',
    });
  });

  it('an ineligible-but-published post still succeeds (browse-only document)', async () => {
    const { fetch } = stubServer(CREATED); // no resource echo
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect((res.data as { cacheEligible: boolean }).cacheEligible).toBe(false);
    expect((res.data as { missing: string[] }).missing).toEqual([]);
  });
});

describe('runPublish — session key mint-once', () => {
  it('the first publish mints the session (one wallet sig); the second reuses it (zero)', async () => {
    const { provider, signCount } = spyProvider();
    const { fetch } = stubServer();
    const deps = hermetic({ fetchImpl: fetch, provider });

    await runPublish(baseArgs(await writeDoc(CLEAN), { mode: 'auto' }), makeCtx(), deps);
    expect(signCount()).toBe(1);

    await runPublish(baseArgs(await writeDoc(CLEAN), { mode: 'auto' }), makeCtx(), deps);
    expect(signCount()).toBe(1); // cached session.json reused, no second popup
  });

  it('the plain-SIWX fallback signs each write with the wallet (no session cached)', async () => {
    const { provider, signCount } = spyProvider();
    const { fetch } = stubServer();
    const deps = hermetic({ fetchImpl: fetch, provider, useSession: false });

    await runPublish(baseArgs(await writeDoc(CLEAN), { mode: 'auto' }), makeCtx(), deps);
    await runPublish(baseArgs(await writeDoc(CLEAN), { mode: 'auto' }), makeCtx(), deps);
    expect(signCount()).toBe(2); // one SIWX signature per write
  });
});

describe('runPublish — review is the default', () => {
  it('a clean publish with no mode, empty env, and no --yes needs confirmation', async () => {
    const { fetch, calls } = stubServer();
    const { provider, signCount } = spyProvider();
    await expect(
      runPublish(
        baseArgs(await writeDoc(CLEAN)),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(calls).toHaveLength(0); // review asks before any write
    expect(signCount()).toBe(0);
  });
});

describe('runPublish — default-mode notice', () => {
  it('prints one stderr notice when publish.mode is unconfigured (source default)', async () => {
    const { provider } = spyProvider();
    const { fetch } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    // --yes clears review so the clean publish proceeds; the default-source notice
    // still fires (source stays 'default' — --yes does not change the mode source).
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { yes: true }),
      ctx,
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect(stderr()).toContain('publish.mode: review (default) - each publish asks you once.');
    expect(stderr()).toContain('tenjin config set publish.mode auto');
  });

  it('omits the notice when the mode is set (source is a flag, not default)', async () => {
    const { provider } = spyProvider();
    const { fetch } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'auto' }),
      ctx,
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect(stderr()).not.toContain('(default)');
  });
});

describe('runPublish — the needs_confirmation payload', () => {
  it('carries mode, price, findings, card completeness, and the target', async () => {
    const file = await writeDoc(WARN);
    const { provider } = spyProvider();
    const { fetch } = stubServer();
    try {
      await runPublish(
        baseArgs(file, { mode: 'auto' }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      );
      throw new Error('expected a throw');
    } catch (err) {
      const e = err as { code?: string; details?: Record<string, unknown> };
      expect(e.code).toBe('NEEDS_CONFIRMATION');
      const d = e.details as {
        mode: string;
        price: { atomic: string; usd: string };
        findings: Array<{ check: string; severity: string }>;
        card: { cacheEligible: boolean; missing: string[] };
        target: { status: string; titlePreview: string };
      };
      expect(d.mode).toBe('auto');
      expect(d.price).toEqual({ atomic: '100000', usd: '0.1' });
      expect(d.findings.some((f) => f.check === 'wallet-address' && f.severity === 'warn')).toBe(
        true,
      );
      expect(d.card.cacheEligible).toBe(false);
      expect(d.target).toEqual({ status: 'published', titlePreview: 'The Answer' });
    }
  });
});

describe('runPublish — --mode edge validation', () => {
  it('rejects an unrecognized --mode as USAGE before any wallet or write', async () => {
    const { fetch, calls } = stubServer();
    const { provider, signCount } = spyProvider();
    const deps = hermetic({ fetchImpl: fetch, provider });
    for (const bad of ['Review', 'reveiw', 'full_auto', '']) {
      await expect(
        runPublish(baseArgs(await writeDoc(CLEAN), { mode: bad }), makeCtx(), deps),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    }
    expect(calls).toHaveLength(0);
    expect(signCount()).toBe(0);
  });
});

describe('runPublish — TENJIN_PUBLISH_MODE', () => {
  it('warns and falls back when the env var is a mistyped value', async () => {
    const { fetch } = stubServer();
    const { provider } = spyProvider();
    const { ctx, stderr } = makeCtxCapturingStderr();
    // A bad env var must not silently degrade: it warns and uses the fallback
    // (default review); --yes lets the clean publish through so we reach the warn.
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { yes: true }),
      ctx,
      hermetic({ fetchImpl: fetch, provider, env: { TENJIN_PUBLISH_MODE: 'reveiw' } }),
    );
    expect(stderr()).toContain('Ignoring invalid TENJIN_PUBLISH_MODE="reveiw"');
  });

  it('honors a valid env mode (review → needs_confirmation on a clean file)', async () => {
    const { fetch, calls } = stubServer();
    const { provider } = spyProvider();
    await expect(
      runPublish(
        baseArgs(await writeDoc(CLEAN)),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider, env: { TENJIN_PUBLISH_MODE: 'review' } }),
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(calls).toHaveLength(0);
  });
});

describe('runPublish — card-flag values pass the scan', () => {
  // A block-tier secret (AWS key); secret-assignment is only warn-tier since B3.1.
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('a secret in --provenance hard-blocks in every mode, like an in-file secret', async () => {
    for (const mode of ['auto', 'full-auto', 'review']) {
      const { fetch, calls } = stubServer();
      const { provider, signCount } = spyProvider();
      await expect(
        runPublish(
          baseArgs(await writeDoc(CLEAN), { mode, yes: true, provenance: SECRET }),
          makeCtx(),
          hermetic({ fetchImpl: fetch, provider }),
        ),
      ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
      expect(calls).toHaveLength(0);
      expect(signCount()).toBe(0);
    }
  });

  it('the same secret in-file and via-flag behave identically (both block)', async () => {
    const viaFlag = runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'full-auto', yes: true, scope: SECRET }),
      makeCtx(),
      hermetic({ ...stubDeps(), provider: spyProvider().provider }),
    );
    await expect(viaFlag).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });

    const inFile = runPublish(
      baseArgs(await writeDoc(`# T\n\n${SECRET}\n`), { mode: 'full-auto', yes: true }),
      makeCtx(),
      hermetic({ ...stubDeps(), provider: spyProvider().provider }),
    );
    await expect(inFile).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
  });
});

function stubDeps(): { fetchImpl: typeof fetch } {
  return { fetchImpl: stubServer().fetch };
}

describe('runPublish — draft end to end', () => {
  it('maps --draft to a draft POST and echoes the draft receipt', async () => {
    const draftPost = {
      ...CREATED,
      status: 'draft',
      url: 'https://preview.example/a/iris/the-answer',
    };
    const { fetch, calls } = stubServer(draftPost);
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { draft: true, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect(calls).toHaveLength(1);
    expect((res.data as { status: string }).status).toBe('draft');
  });

  it('a --draft needs_confirmation carries target.status "draft"', async () => {
    const { fetch } = stubServer();
    const { provider } = spyProvider();
    try {
      await runPublish(
        baseArgs(await writeDoc(WARN), { draft: true, mode: 'review' }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      );
      throw new Error('expected a throw');
    } catch (err) {
      const e = err as { code?: string; details?: { target?: { status?: string } } };
      expect(e.code).toBe('NEEDS_CONFIRMATION');
      expect(e.details?.target?.status).toBe('draft');
    }
  });
});

describe('runPublish — publish --candidate', () => {
  const LOOKUP = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  async function park(over: { draft?: string; question?: string } = {}): Promise<string> {
    const rec = await createCandidate(dir, {
      draft: over.draft ?? CLEAN,
      lookupId: LOOKUP,
      ...(over.question !== undefined ? { question: over.question } : {}),
      created: new Date().toISOString(),
      sourceProject: dir,
    });
    return rec.id;
  }

  /** A stub server that also captures the parsed request body. */
  function bodyServer(post: Record<string, unknown> = CREATED): {
    fetch: typeof fetch;
    body: () => Record<string, unknown> | undefined;
  } {
    let captured: Record<string, unknown> | undefined;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      captured = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(post), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, body: () => captured };
  }

  it('publishes a parked candidate and clears it on success', async () => {
    const id = await park();
    const { fetch, calls } = stubServer();
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(undefined, { candidate: id, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect(calls).toHaveLength(1);
    expect((res.data as { candidate?: { id: string; cleared: boolean } }).candidate).toEqual({
      id,
      cleared: true,
    });
    expect(await readCandidate(dir, id)).toBeNull(); // dropped
  });

  it('prefills questionsAnswered from the candidate meta, explicit --question wins', async () => {
    const id = await park({ question: 'What does the meta ask?' });
    const { fetch, body } = bodyServer();
    const { provider } = spyProvider();
    await runPublish(
      baseArgs(undefined, { candidate: id, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect((body()?.resource as { questionsAnswered?: string[] })?.questionsAnswered).toEqual([
      'What does the meta ask?',
    ]);

    // An explicit --question overrides the candidate prefill.
    const id2 = await park({ question: 'meta question' });
    const server2 = bodyServer();
    await runPublish(
      baseArgs(undefined, { candidate: id2, question: ['flag question'], mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: server2.fetch, provider: spyProvider().provider }),
    );
    expect(
      (server2.body()?.resource as { questionsAnswered?: string[] })?.questionsAnswered,
    ).toEqual(['flag question']);
  });

  it('a refused candidate publish stays parked (needs_confirmation)', async () => {
    const id = await park();
    const { fetch, calls } = stubServer();
    const { provider, signCount } = spyProvider();
    await expect(
      runPublish(
        baseArgs(undefined, { candidate: id, mode: 'review' }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(calls).toHaveLength(0);
    expect(signCount()).toBe(0);
    expect(await readCandidate(dir, id)).not.toBeNull(); // still parked
  });

  it('a hard-blocked candidate publish stays parked (publish_blocked)', async () => {
    const id = await park({ draft: `# T\n\nThe leaked key is 0x${'a'.repeat(64)}\n` });
    const { fetch, calls } = stubServer();
    const { provider, signCount } = spyProvider();
    await expect(
      runPublish(
        baseArgs(undefined, { candidate: id, mode: 'full-auto', yes: true }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    expect(calls).toHaveLength(0);
    expect(signCount()).toBe(0);
    expect(await readCandidate(dir, id)).not.toBeNull();
  });

  it('--draft combines with --candidate', async () => {
    const id = await park();
    const { fetch } = stubServer({ ...CREATED, status: 'draft' });
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(undefined, { candidate: id, draft: true, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect((res.data as { status: string }).status).toBe('draft');
    expect(await readCandidate(dir, id)).toBeNull();
  });

  it('a malformed or unknown candidate id is USAGE before any wallet touch', async () => {
    const { fetch, calls } = stubServer();
    const { provider, signCount } = spyProvider();
    const deps = hermetic({ fetchImpl: fetch, provider });
    await expect(
      runPublish(baseArgs(undefined, { candidate: 'not-a-uuid' }), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    await expect(
      runPublish(
        baseArgs(undefined, { candidate: '0197ffff-bbbb-cccc-dddd-eeeeeeeeeeee' }),
        makeCtx(),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(calls).toHaveLength(0);
    expect(signCount()).toBe(0);
  });

  it('a file AND --candidate together is USAGE; neither is USAGE', async () => {
    const id = await park();
    const { fetch } = stubServer();
    const { provider } = spyProvider();
    const deps = hermetic({ fetchImpl: fetch, provider });
    await expect(
      runPublish(baseArgs(await writeDoc(CLEAN), { candidate: id }), makeCtx(), deps),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(runPublish(baseArgs(undefined), makeCtx(), deps)).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('frontmatter questionsAnswered beats the candidate meta question', async () => {
    // The untested middle precedence tier: frontmatter wins over the candidate
    // prefill (an explicit --question would win over both).
    const id = await park({
      question: 'meta question',
      draft: ['---', 'questionsAnswered:', '  - fm question', '---', '# T', '', 'body'].join('\n'),
    });
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(undefined, { candidate: id, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect((body()?.resource as { questionsAnswered?: string[] })?.questionsAnswered).toEqual([
      'fm question',
    ]);
  });

  it('a post-approval publish failure leaves the candidate parked (500 and network)', async () => {
    // 500 after approval → PUBLISH_FAILED exit 4, candidate NOT cleared.
    const id500 = await park();
    const fail500 = (async () =>
      new Response(JSON.stringify({ error: { code: 'server_error', message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(
      runPublish(
        baseArgs(undefined, { candidate: id500, mode: 'full-auto' }),
        makeCtx(),
        hermetic({ fetchImpl: fail500, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED', exitCode: 4 });
    expect(await readCandidate(dir, id500)).not.toBeNull();

    // A network failure after approval → still parked (only a 201 clears).
    const idNet = await park();
    const failNet = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      runPublish(
        baseArgs(undefined, { candidate: idNet, mode: 'full-auto' }),
        makeCtx(),
        hermetic({ fetchImpl: failNet, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(await readCandidate(dir, idNet)).not.toBeNull();
  });

  it('a block-tier secret in the candidate question hard-blocks and stays parked', async () => {
    // Pins that the meta-question prefill flows through cardScanText → scan: a
    // refactor that prefilled AFTER the scan would reopen the card-flag bypass.
    const id = await park({ question: 'How do I use AKIAIOSFODNN7EXAMPLE?' });
    const { fetch, calls } = stubServer();
    const { provider, signCount } = spyProvider();
    await expect(
      runPublish(
        baseArgs(undefined, { candidate: id, mode: 'full-auto', yes: true }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
    expect(calls).toHaveLength(0);
    expect(signCount()).toBe(0);
    expect(await readCandidate(dir, id)).not.toBeNull(); // still parked
  });

  it('a clear failure after a successful publish stays ok:true with cleared:false + warning', async () => {
    // Only meaningful where unix perms bite and the runner is not root.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const id = await park();
    const { fetch } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    // Make the candidates dir un-writable so dropCandidate's rm throws AFTER the 201.
    await chmod(join(dir, 'candidates'), 0o500);
    try {
      const res = await runPublish(
        baseArgs(undefined, { candidate: id, mode: 'auto' }),
        ctx,
        hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
      );
      const c = (res.data as { candidate: { id: string; cleared: boolean; warning?: string } })
        .candidate;
      expect(c).toMatchObject({ id, cleared: false });
      expect(c.warning).toContain('could not clear candidate');
      expect(stderr()).toContain('could not clear candidate');
    } finally {
      await chmod(join(dir, 'candidates'), 0o700); // restore so afterEach cleanup works
    }
  });
});
