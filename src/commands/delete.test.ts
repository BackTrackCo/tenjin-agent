import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelete, type DeleteArgs, type DeleteDeps } from './delete';
import { testSigner, testWalletProvider } from '../lib/read-test-utils';
import { sessionPath } from '../lib/paths';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-delete-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const STORED = {
  id: POST_ID,
  slug: 'the-answer',
  title: 'The Answer',
  status: 'published',
  price: '100000',
  url: 'https://preview.example/a/iris/the-answer',
  excerpt: 'A short stored excerpt.',
  bodyMd: '# The Answer\n\nThe stored body.\n',
  tags: [],
};

function makeCtx(isTTY = false): { ctx: CommandContext; stderr: () => string } {
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
      io: { stdout: sink(), stderr: errStream, isTTY },
    },
  };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function stubServer(opts: { get?: Record<string, unknown>; deleteStatus?: number } = {}): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), headers });
    if (method === 'DELETE') {
      return new Response(null, { status: opts.deleteStatus ?? 204 });
    }
    return new Response(JSON.stringify(opts.get ?? STORED), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

/** Hermetic deps; `TENJIN_PUBLISH_MODE` is set on purpose and must not matter. */
function hermetic(mode: string, over: DeleteDeps = {}): DeleteDeps {
  return {
    env: { TENJIN_PUBLISH_MODE: mode },
    provider: testWalletProvider(),
    ...over,
  };
}

function args(over: Partial<DeleteArgs> = {}): DeleteArgs {
  return { postId: POST_ID, ...over };
}

describe('runDelete — consent in every mode', () => {
  // The heart of #221's consent design: publish.mode is consent to PUBLISH, so
  // the loosest mode there still buys nothing here.
  it.each(['review', 'auto', 'full-auto'])(
    'refuses without --yes under publish.mode %s and deletes nothing',
    async (mode) => {
      const stub = stubServer();
      const { ctx } = makeCtx();
      await expect(
        runDelete(args(), ctx, hermetic(mode, { fetchImpl: stub.fetch })),
      ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION', exitCode: 3 });
      expect(stub.calls.map((c) => c.method)).toEqual(['GET']);
    },
  );

  it.each(['review', 'auto', 'full-auto'])(
    '--yes is what confirms, identically under publish.mode %s',
    async (mode) => {
      const stub = stubServer();
      const { ctx } = makeCtx();
      const res = await runDelete(
        args({ yes: true }),
        ctx,
        hermetic(mode, { fetchImpl: stub.fetch }),
      );
      expect(res.data).toMatchObject({ deleted: true, postId: POST_ID });
      expect(stub.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    },
  );

  // The payload is what an agent renders to the user, so it has to carry the
  // identity of the piece AND the command that answers it (#221's own report was
  // an agent inventing a verb because nothing handed it one).
  it('the exit-3 payload names the piece, the confirm command, and the reversible alternative', async () => {
    const stub = stubServer();
    const { ctx } = makeCtx();
    const err = (await runDelete(args(), ctx, hermetic('auto', { fetchImpl: stub.fetch })).catch(
      (e: unknown) => e,
    )) as { code: string; details: Record<string, unknown> };
    expect(err.code).toBe('NEEDS_CONFIRMATION');
    expect(err.details).toMatchObject({
      postId: POST_ID,
      title: 'The Answer',
      status: 'published',
      url: STORED.url,
      irreversible: true,
      confirmCommand: `tenjin delete ${POST_ID} --yes`,
      reversibleAlternative: `tenjin edit ${POST_ID} --status draft`,
    });
  });

  it('asks interactively when a confirm seam is present, and a no deletes nothing', async () => {
    const stub = stubServer();
    const { ctx } = makeCtx(true);
    const prompts: string[] = [];
    await expect(
      runDelete(
        args(),
        ctx,
        hermetic('full-auto', {
          fetchImpl: stub.fetch,
          confirm: async (p) => {
            prompts.push(p);
            return false;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('The Answer');
    expect(prompts[0]).toContain('[y/N]');
    expect(stub.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('an interactive yes deletes', async () => {
    const stub = stubServer();
    const { ctx } = makeCtx(true);
    const res = await runDelete(
      args(),
      ctx,
      hermetic('review', { fetchImpl: stub.fetch, confirm: async () => true }),
    );
    expect(res.data).toMatchObject({ deleted: true });
    expect(stub.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });
});

describe('runDelete — the request', () => {
  it('reads the post first, then signs a DELETE at the same owner-scoped url', async () => {
    const stub = stubServer();
    const { ctx } = makeCtx();
    await runDelete(args({ yes: true }), ctx, hermetic('review', { fetchImpl: stub.fetch }));
    expect(stub.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    for (const call of stub.calls) {
      expect(call.url).toBe(`https://preview.example/api/posts/${POST_ID}`);
    }
    // The DELETE is signed: the session-key path stamps the RFC 9421 headers, and
    // a bodiless request covers no content-digest.
    const del = stub.calls[1];
    expect(del?.headers['signature']).toBeDefined();
    expect(del?.headers['tenjin-session-delegation']).toBeDefined();
    expect(del?.headers['content-digest']).toBeUndefined();
  });

  it('rejects a non-uuid before touching the wallet or the network', async () => {
    const stub = stubServer();
    const { ctx } = makeCtx();
    await expect(
      runDelete(
        { postId: 'the-answer', yes: true },
        ctx,
        hermetic('review', { fetchImpl: stub.fetch }),
      ),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(stub.calls).toHaveLength(0);
  });

  it('maps a 404 to RESOURCE_NOT_FOUND and never asks about a post it could not read', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'not_found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const { ctx } = makeCtx();
    await expect(runDelete(args(), ctx, hermetic('auto', { fetchImpl }))).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  // A refusal AFTER the operator said yes is the settlement class, and the fix
  // has to say the piece is still up: an agent reporting exit 4 as "removed"
  // would be reporting the opposite of what happened.
  it('maps a post-confirmation server refusal to DELETE_FAILED (exit 4)', async () => {
    const stub = stubServer({ deleteStatus: 500 });
    const { ctx } = makeCtx();
    const err = (await runDelete(
      args({ yes: true }),
      ctx,
      hermetic('review', { fetchImpl: stub.fetch }),
    ).catch((e: unknown) => e)) as { code: string; exitCode: number; fix?: string };
    expect(err.code).toBe('DELETE_FAILED');
    expect(err.exitCode).toBe(4);
    expect(err.fix).toMatch(/still live/i);
  });

  it('prints what would go before asking, so a headless caller sees it on stderr too', async () => {
    const stub = stubServer();
    const { ctx, stderr } = makeCtx();
    await runDelete(args(), ctx, hermetic('auto', { fetchImpl: stub.fetch })).catch(
      () => undefined,
    );
    expect(stderr()).toContain('Delete The Answer (published), 0.1 USD');
    expect(stderr()).toContain(STORED.url);
  });
});

/**
 * Least privilege on every refusal path. NO REFUSED DELETE MAY LEAVE A WRITE
 * CREDENTIAL BEHIND — not the headless first call an agent makes to render the
 * payload, and not a human who was asked and said no. Both would otherwise cache
 * a `read+write` delegation that later writes reuse with no wallet signature,
 * i.e. a credential granted as the side effect of declining.
 *
 * So the scope tracks APPROVAL rather than the ability to ask: the read the
 * preview is built from is `read`, and only `--yes` or a yes at the prompt mints
 * `read+write`. The signature counts below are what keeps that honest.
 */
describe('runDelete — the session is scoped to what the run was approved to do', () => {
  /** The scope of the delegation cached on disk, or null when none was minted. */
  async function cachedScope(): Promise<string | null> {
    try {
      const raw = await readFile(sessionPath(dir), 'utf8');
      return (JSON.parse(raw) as { scope?: string }).scope ?? null;
    } catch {
      return null;
    }
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

  it('a headless refusal mints a READ-scoped session, never a write-capable one', async () => {
    const stub = stubServer();
    const { provider } = spyProvider();
    const { ctx } = makeCtx();
    await expect(
      runDelete(args(), ctx, {
        env: { TENJIN_PUBLISH_MODE: 'full-auto' },
        provider,
        fetchImpl: stub.fetch,
      }),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(await cachedScope()).toBe('read');
  });

  it('--yes mints read+write, because that run really does write', async () => {
    const stub = stubServer();
    const { provider } = spyProvider();
    const { ctx } = makeCtx();
    await runDelete(args({ yes: true }), ctx, {
      env: { TENJIN_PUBLISH_MODE: 'review' },
      provider,
      fetchImpl: stub.fetch,
    });
    expect(await cachedScope()).toBe('read+write');
  });

  // The narrowing must not cost a signature on the path that can write: a cached
  // read+write covers a read, so the confirm round trip stays one popup total.
  it('a cached read+write session serves the refusal read with no new signature', async () => {
    const { provider, signCount } = spyProvider();
    const { ctx } = makeCtx();
    await runDelete(args({ yes: true }), ctx, {
      env: {},
      provider,
      fetchImpl: stubServer().fetch,
    });
    expect(signCount()).toBe(1);
    expect(await cachedScope()).toBe('read+write');

    await expect(
      runDelete(args(), ctx, { env: {}, provider, fetchImpl: stubServer().fetch }),
    ).rejects.toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(signCount()).toBe(1);
    expect(await cachedScope()).toBe('read+write'); // never rebuilt downward
  });

  /**
   * THE CASE THE TWO-PHASE MINT EXISTS FOR (review follow-up on #222). Being able
   * to ask is not being told yes: an interactive run that is declined must end
   * with no write credential on disk, exactly like the headless refusal above.
   * Keying the scope on the ability to prompt granted it for being asked.
   */
  it('a declined prompt leaves only a read-scoped session, never a write-capable one', async () => {
    const stub = stubServer();
    const { provider } = spyProvider();
    const { ctx } = makeCtx(true);
    await expect(
      runDelete(args(), ctx, {
        env: {},
        provider,
        fetchImpl: stub.fetch,
        confirm: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'REFUSED' });
    expect(await cachedScope()).toBe('read');
    expect(stub.calls.map((c) => c.method)).toEqual(['GET']);
  });

  /**
   * The cost of the split, measured rather than asserted. An approved interactive
   * delete pays ONE extra signature: `establishSession` opens no keystore and
   * makes no network call, so the upgrade is an in-memory sign with the signer
   * resolved once at the top, on the path where the user has just said yes.
   */
  it('an approved prompt upgrades to read+write for one extra silent signature', async () => {
    const stub = stubServer();
    const { provider, signCount } = spyProvider();
    const { ctx } = makeCtx(true);
    await runDelete(args(), ctx, {
      env: {},
      provider,
      fetchImpl: stub.fetch,
      confirm: async () => true,
    });
    expect(signCount()).toBe(2); // read for the preview, read+write for the write
    expect(await cachedScope()).toBe('read+write');
    expect(stub.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });

  // The split must not make the already-approved path pay twice: --yes asks for
  // the wider scope in the read phase, so the write phase reuses that session.
  it('--yes signs exactly once across both phases', async () => {
    const stub = stubServer();
    const { provider, signCount } = spyProvider();
    const { ctx } = makeCtx();
    await runDelete(args({ yes: true }), ctx, { env: {}, provider, fetchImpl: stub.fetch });
    expect(signCount()).toBe(1);
    expect(stub.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });
});
