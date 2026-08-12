import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublish, type PublishArgs, type PublishDeps } from './publish';
import { loadSearches, recordSearch, searchStoreLockPath } from '../lib/search-store';
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

/**
 * A spy wallet provider counting wallet signatures (the establish popup) and,
 * separately, `getSigner` calls. The two are NOT the same moment: signing is lazy
 * and happens inside the write, while `getSigner` is the keystore unlock the
 * command does up front. An edge check that refuses before touching the wallet is
 * only observable on the second counter.
 */
function spyProvider(): {
  provider: WalletProvider;
  signCount: () => number;
  getSignerCount: () => number;
} {
  const inner = testSigner();
  let n = 0;
  let unlocks = 0;
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
    getSignerCount: () => unlocks,
    provider: {
      id: 'local',
      describe: async () => ({
        address: signer.address,
        provider: 'local',
        credentialSource: 'file',
        policyEnforcement: 'client-only',
      }),
      getSigner: async () => {
        unlocks++;
        return signer;
      },
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

  // Every field on the receipt line is server-sent, and it is the line an author
  // reads to learn where their piece went and in what state. A repaint escape or
  // a bidi override in `status` or `url` (both bare z.string() on the wire) must
  // not reach the terminal, the same as the title beside them.
  it('sanitizes the server status and url on the human receipt line', async () => {
    const { fetch } = stubServer({
      ...CREATED,
      status: 'published\u001b[2K\rdraft',
      url: 'https://preview.example/a/iris/\u202egpj.exe',
    });
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    const line = res.humanLines?.[0] ?? '';
    expect(line).toBe(
      'Published The Answer (publisheddraft) for 0.1 USD → https://preview.example/a/iris/gpj.exe',
    );
    // eslint-disable-next-line no-control-regex
    expect(/[\u001b\u202a-\u202e]/.test(line)).toBe(false);
    // The machine envelope is untouched: --json still carries the server's bytes.
    expect((res.data as { url: string }).url).toBe('https://preview.example/a/iris/\u202egpj.exe');
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

describe('runPublish — source-project scan context (#36)', () => {
  async function gitConfigAt(root: string, slug = 'AcmeCorp/secret-svc'): Promise<void> {
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(
      join(root, '.git', 'config'),
      `[remote "origin"]\n\turl = git@github.com:${slug}.git\n`,
      'utf8',
    );
  }

  it('a draft mentioning its own repo slug needs confirmation in auto mode', async () => {
    await gitConfigAt(dir);
    const file = await writeDoc('# T\n\nas shipped in AcmeCorp/secret-svc last week\n');
    const { fetch, calls } = stubServer();
    const { provider } = spyProvider();
    const err = (await runPublish(
      baseArgs(file, { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    ).catch((e: unknown) => e)) as { code: string; details: { findings: { check: string }[] } };
    expect(err.code).toBe('NEEDS_CONFIRMATION');
    expect(err.details.findings.map((f) => f.check)).toContain('private-repo-reference');
    expect(calls).toHaveLength(0);
  });

  it('a clean draft in the same checkout still auto-publishes', async () => {
    await gitConfigAt(dir);
    const { fetch, calls } = stubServer();
    const { provider } = spyProvider();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider }),
    );
    expect((res.data as { resourceId: string }).resourceId).toBe(CREATED.id);
    expect(calls).toHaveLength(1);
  });

  // Markers derive from the DRAFT's project, not the shell's cwd (review r5 fix,
  // pinned in r6: every earlier fixture had cwd === draft dir === sourceProject,
  // so a revert of markerRoot to plain cwd passed the suite unchanged). Here the
  // shell cwd is a DIFFERENT checkout with its own remote: the draft-repo slug
  // must warn, and the cwd-repo slug must not.
  it('file publish scans with the draft directory markers, not the cwd markers (review r6)', async () => {
    const shellDir = join(dir, 'shell');
    const projectDir = join(dir, 'project');
    await mkdir(shellDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await gitConfigAt(shellDir, 'OtherOrg/shell-tools');
    await gitConfigAt(projectDir, 'AcmeCorp/secret-svc');

    // Draft mentions ITS OWN repo: warns even though cwd is another checkout.
    const file = join(projectDir, 'post.md');
    await writeFile(file, '# T\n\nas shipped in AcmeCorp/secret-svc last week\n', 'utf8');
    const err = (await runPublish(
      baseArgs(file, { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: stubServer().fetch, provider: spyProvider().provider, cwd: shellDir }),
    ).catch((e: unknown) => e)) as { code: string; details: { findings: { check: string }[] } };
    expect(err.code).toBe('NEEDS_CONFIRMATION');
    expect(err.details.findings.map((f) => f.check)).toContain('private-repo-reference');

    // Draft mentions the SHELL's repo: the cwd markers are not consulted.
    const file2 = join(projectDir, 'post2.md');
    await writeFile(file2, '# T\n\nas shipped in OtherOrg/shell-tools last week\n', 'utf8');
    const { fetch, calls } = stubServer();
    const res = await runPublish(
      baseArgs(file2, { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider, cwd: shellDir }),
    );
    expect((res.data as { resourceId: string }).resourceId).toBe(CREATED.id);
    expect(calls).toHaveLength(1);
  });
});

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

describe('runPublish — publish <file> --search-id', () => {
  const SEARCH = '0197bbbb-cccc-dddd-eeee-ffffffffffff';
  const QUESTION = 'does ox 0.14 still export Bytes.from';

  /** Seed the local store with the MISS a publish is about to close. */
  async function seed(question: string = QUESTION): Promise<void> {
    await recordSearch(dir, {
      searchId: SEARCH,
      at: new Date().toISOString(),
      question,
      decision: 'MISS',
      candidates: [],
    });
  }

  /** A stub server that also captures the parsed request body. */
  function bodyServer(): { fetch: typeof fetch; body: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      captured = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, body: () => captured };
  }

  function questionsIn(body: Record<string, unknown> | undefined): string[] | undefined {
    return (body?.resource as { questionsAnswered?: string[] } | undefined)?.questionsAnswered;
  }

  // The gap this flag closes: the path the Stop hook and the auto-mode skill
  // prescribe is a bare file publish, which left the loop open.
  it('resolves the named search on a successful file publish', async () => {
    await seed();
    const { fetch } = stubServer();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('publish');
    // --json suppresses the stderr notes, so the receipt is the only signal an
    // agent gets about whether its loop actually closed.
    expect((res.data as { search?: unknown }).search).toEqual({
      id: SEARCH,
      closed: true,
      prefill: 'applied',
    });
    expect(res.humanLines).toContain(`Closed the loop on search ${SEARCH}.`);
  });

  it('omits the search field entirely when --search-id was not passed', async () => {
    const { fetch } = stubServer();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(res.data).not.toHaveProperty('search');
  });

  // The entry aged past the store cap or came from another machine: there is no
  // loop here to close, and that must not cost the caller their publish.
  it('publishes normally on an unknown search id, resolving nothing', async () => {
    const { fetch, calls } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      ctx,
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(calls).toHaveLength(1);
    expect((res.data as { status: string }).status).toBe('published');
    expect(await loadSearches(dir)).toEqual([]);
    expect(stderr()).toContain(`search ${SEARCH} is not in the local store`);
    expect((res.data as { search?: unknown }).search).toEqual({
      id: SEARCH,
      closed: false,
      prefill: 'none',
    });
  });

  // A draft parks privately and answers nobody, so the loop is still open.
  it('leaves the loop open on a --draft publish', async () => {
    await seed();
    const { fetch } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, draft: true, mode: 'auto' }),
      ctx,
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect((await loadSearches(dir))[0]?.resolved).toBeUndefined();
    expect(stderr()).toContain(`search ${SEARCH} stays open`);
    expect((res.data as { search?: unknown }).search).toEqual({
      id: SEARCH,
      closed: false,
      prefill: 'applied',
    });
  });

  it('leaves the loop open when the publish was refused', async () => {
    await seed();
    const { fetch } = stubServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'review' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    ).catch(() => undefined);
    expect((await loadSearches(dir))[0]?.resolved).toBeUndefined();
  });

  // The searched phrasing is what the next searcher sends, so it is the right
  // fallback for the card — behind anything the author wrote themselves.
  it('prefills questionsAnswered from the stored search question', async () => {
    await seed();
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(questionsIn(body())).toEqual([QUESTION]);
  });

  it('an explicit --question beats the stored search question', async () => {
    await seed();
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), {
        searchId: SEARCH,
        question: ['flag question'],
        mode: 'auto',
      }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(questionsIn(body())).toEqual(['flag question']);
  });

  it('frontmatter questionsAnswered beats the stored search question', async () => {
    await seed();
    const doc = await writeDoc(
      ['---', 'questionsAnswered:', '  - fm question', '---', '# T', '', 'body'].join('\n'),
    );
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(doc, { searchId: SEARCH, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(questionsIn(body())).toEqual(['fm question']);
  });

  // A search question may run to the server's 512, past the card's 200-char item
  // bound: prefilling it would fail a publish that was otherwise fine.
  it('skips the prefill when the stored question exceeds the card item bound', async () => {
    await seed('q'.repeat(201));
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(questionsIn(body())).toBeUndefined();
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('publish');
  });

  it('refuses a --search-id that is not a uuid', async () => {
    const { fetch, calls } = stubServer();
    await expect(
      runPublish(
        baseArgs(await writeDoc(CLEAN), { searchId: 'not-a-uuid', mode: 'auto' }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });
});

describe('runPublish — the public preview (--excerpt)', () => {
  /** A stub server that also captures the parsed request body. */
  function bodyServer(): { fetch: typeof fetch; body: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      captured = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, body: () => captured };
  }

  const withFrontmatter = (excerpt: string): string =>
    ['---', `excerpt: ${excerpt}`, '---', '# The Answer', '', 'A plain body.'].join('\n');

  it('sends an explicit --excerpt as the public preview', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { excerpt: 'What it answers, as of 2026-08.', mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()?.excerpt).toBe('What it answers, as of 2026-08.');
  });

  it('falls back to frontmatter excerpt', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(withFrontmatter('from the frontmatter')), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()?.excerpt).toBe('from the frontmatter');
  });

  it('an explicit --excerpt beats the frontmatter one', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(withFrontmatter('from the frontmatter')), {
        excerpt: 'from the flag',
        mode: 'auto',
      }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()?.excerpt).toBe('from the flag');
  });

  // Absent, the server derives one from the body's leading prose; sending nothing
  // is what lets it, so an empty key must not be invented here.
  it('sends no excerpt at all when neither names one', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()).not.toHaveProperty('excerpt');
  });

  // REFUSED, never truncated: a silently cut preview is a different preview, and
  // controlling exactly what a non-buyer reads is the whole point of setting one.
  it('refuses an over-long excerpt at the edge, before any wallet touch', async () => {
    const { fetch, calls } = stubServer();
    const { provider, signCount, getSignerCount } = spyProvider();
    await expect(
      runPublish(
        baseArgs(await writeDoc(CLEAN), { excerpt: 'e'.repeat(501), mode: 'auto' }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE', message: expect.stringContaining('500') });
    expect(calls).toHaveLength(0);
    expect(signCount()).toBe(0);
    // The point of the edge check: the request builder catches this too, but only
    // after the keystore is already open.
    expect(getSignerCount()).toBe(0);
  });

  it('refuses an over-long frontmatter excerpt the same way', async () => {
    const { fetch, calls } = stubServer();
    const { provider, getSignerCount } = spyProvider();
    await expect(
      runPublish(
        baseArgs(await writeDoc(withFrontmatter('e'.repeat(501))), { mode: 'auto' }),
        makeCtx(),
        hermetic({ fetchImpl: fetch, provider }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
    expect(getSignerCount()).toBe(0);
  });

  it('keeps one at exactly the bound', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { excerpt: 'e'.repeat(500), mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(String(body()?.excerpt)).toHaveLength(500);
  });
});

describe('runPublish — public card text is sanitized', () => {
  const SEARCH = '0197bbbb-cccc-dddd-eeee-ffffffffffff';
  // A CSI sequence and an RTL override: `trim()` removes neither, and both ride
  // into text every future buyer reads.
  const CSI = '\x1b[31mred\x1b[0m';
  const RTL = 'safe‮txet dekcirt';

  function bodyServer(): { fetch: typeof fetch; body: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      captured = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, body: () => captured };
  }

  const questionsIn = (b: Record<string, unknown> | undefined): string[] | undefined =>
    (b?.resource as { questionsAnswered?: string[] } | undefined)?.questionsAnswered;

  async function seed(question: string): Promise<void> {
    await recordSearch(dir, {
      searchId: SEARCH,
      at: new Date().toISOString(),
      question,
      decision: 'MISS',
      candidates: [],
    });
  }

  it('strips a CSI sequence from the prefilled question', async () => {
    await seed(CSI);
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(questionsIn(body())).toEqual(['red']);
  });

  it('strips a bidi override from the prefilled question', async () => {
    await seed(RTL);
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(questionsIn(body())?.[0]).not.toContain('‮');
    expect(questionsIn(body())?.[0]).toContain('safe');
  });

  it('strips a CSI sequence from the excerpt', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { excerpt: CSI, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()?.excerpt).toBe('red');
  });

  it('strips a bidi override from the excerpt', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { excerpt: RTL, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(String(body()?.excerpt)).not.toContain('‮');
  });

  // Ordinary unicode is not collateral damage: an emoji ZWJ sequence and
  // non-latin script survive byte-identical.
  it('keeps ordinary unicode, including emoji ZWJ sequences', async () => {
    const { fetch, body } = bodyServer();
    const text = 'ハンドブック 👩‍💻 — café';
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { excerpt: text, mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()?.excerpt).toBe(text);
  });

  // Single-line fields: a newline folds to a space rather than vanishing, which
  // would run the words on either side of it together.
  it('folds a newline in the excerpt to a space', async () => {
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(CLEAN), { excerpt: 'first line\nsecond line', mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(body()?.excerpt).toBe('first line second line');
  });
});

describe('runPublish — the dropped prefill is reported', () => {
  const SEARCH = '0197bbbb-cccc-dddd-eeee-ffffffffffff';

  async function seed(question: string): Promise<void> {
    await recordSearch(dir, {
      searchId: SEARCH,
      at: new Date().toISOString(),
      question,
      decision: 'MISS',
      candidates: [],
    });
  }

  // --json suppresses stderr, so the receipt has to carry it too: otherwise the
  // card just comes back without the question the caller asked for.
  it('says so on stderr AND on the receipt when the question is too long', async () => {
    await seed('q'.repeat(201));
    const { fetch } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
      ctx,
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(stderr()).toContain('longer than 200 characters');
    expect((res.data as { search: { prefill: string } }).search.prefill).toBe('dropped-too-long');
  });

  it('reports prefill none when the draft named its own questions', async () => {
    await seed('a short question');
    const { fetch } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    const res = await runPublish(
      baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, question: ['mine'], mode: 'auto' }),
      ctx,
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect((res.data as { search: { prefill: string } }).search.prefill).toBe('none');
    expect(stderr()).not.toContain('longer than');
  });
});

// Every agent-supplied field that ships, driven through one payload. The strip
// lives in the shared wire builder, so this covers `edit` and both MCP tools by
// construction — but the fields are enumerated here because a NEW card field
// added without a strip is exactly the regression this catches.
describe('runPublish — every wire field is stripped, not just the two', () => {
  const CSI = '\x1b[31mred\x1b[0m';
  const RTL = 'a‮tricked';

  function bodyServer(): { fetch: typeof fetch; body: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    const fetchFn = (async (_u: string | URL, init?: RequestInit) => {
      captured = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(CREATED), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, body: () => captured };
  }

  /** Publish with `payload` in every text field, and hand back what went out. */
  async function publishWith(payload: string): Promise<Record<string, unknown>> {
    const doc = ['---', `title: ${payload}`, `tags: [${payload}]`, '---', '# H', '', 'body'].join(
      '\n',
    );
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(doc), {
        mode: 'auto',
        excerpt: payload,
        question: [payload],
        task: [payload],
        scope: payload,
        exclusions: payload,
        provenance: payload,
        methodology: payload,
        appliesTo: [`products=${payload}`],
      }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    return body() ?? {};
  }

  /** Every string that reached the wire, flattened. */
  function wireStrings(sent: Record<string, unknown>): string[] {
    const card = (sent.resource ?? {}) as Record<string, unknown>;
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object')
        Object.entries(v).forEach(([k, x]) => {
          out.push(k);
          walk(x);
        });
    };
    for (const key of ['title', 'excerpt', 'tags']) walk(sent[key]);
    walk(card);
    return out;
  }

  it('strips a CSI sequence from every field, card included', async () => {
    const sent = await publishWith(CSI);
    // The payload landed everywhere it could, so the assertion is meaningful.
    expect(sent.title).toBe('red');
    expect(sent.excerpt).toBe('red');
    expect(sent.tags).toEqual(['red']);
    const card = sent.resource as Record<string, unknown>;
    expect(card.questionsAnswered).toEqual(['red']);
    expect(card.tasksSupported).toEqual(['red']);
    expect(card.scope).toBe('red');
    expect(card.exclusions).toBe('red');
    expect(card.provenanceSummary).toBe('red');
    expect(card.methodologySummary).toBe('red');
    expect(card.appliesTo).toEqual({ products: ['red'] });
    for (const s of wireStrings(sent)) expect(s).not.toContain('\x1b');
  });

  it('strips a bidi override from every field, card included', async () => {
    const sent = await publishWith(RTL);
    for (const s of wireStrings(sent)) expect(s).not.toContain('‮');
    expect(sent.title).toBe('atricked');
  });

  // The body is the author's document and is deliberately NOT rewritten.
  it('leaves bodyMd alone', async () => {
    const doc = `# Title\n\nA line with ${CSI} in it.\n`;
    const { fetch, body } = bodyServer();
    await runPublish(
      baseArgs(await writeDoc(doc), { mode: 'auto' }),
      makeCtx(),
      hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
    );
    expect(String(body()?.bodyMd)).toContain('\x1b[31m');
  });
});

// The money bug: `closed` must describe what the local write DID, not what it
// tried to do. `markSearchResolved` swallows its failures by design, so without
// this the receipt can go back to claiming a close that never landed — and an
// agent that believes a paid loop closed does not publish it again, or does.
describe('runPublish — a search the store could not close reports closed:false', () => {
  const SEARCH = '0197bbbb-cccc-dddd-eeee-ffffffffffff';

  it('reports closed:false and names the recovery when the store lock is held', async () => {
    await recordSearch(dir, {
      searchId: SEARCH,
      at: new Date().toISOString(),
      question: 'a question nobody had answered',
      decision: 'MISS',
      candidates: [],
    });
    // A lock nobody releases: the resolve cannot land. Held for the whole
    // publish, so the failure is the real one rather than a stubbed return.
    await mkdir(searchStoreLockPath(dir), { recursive: true });
    const { fetch, calls } = stubServer();
    const { ctx, stderr } = makeCtxCapturingStderr();
    try {
      const res = await runPublish(
        baseArgs(await writeDoc(CLEAN), { searchId: SEARCH, mode: 'auto' }),
        ctx,
        hermetic({ fetchImpl: fetch, provider: spyProvider().provider }),
      );
      // The publish itself still succeeded: bookkeeping never fails the write.
      expect(calls).toHaveLength(1);
      expect((res.data as { status: string }).status).toBe('published');
      expect((res.data as { search: { closed: boolean } }).search.closed).toBe(false);
      expect(stderr()).toContain('could not be updated');
      expect(stderr()).toContain(`tenjin outcome --search-id ${SEARCH}`);
      // And the loop really is still open, so the reminder is right to fire.
      expect((await loadSearches(dir))[0]?.resolved).toBeUndefined();
    } finally {
      await rm(searchStoreLockPath(dir), { recursive: true, force: true });
    }
  }, 15_000);
});
