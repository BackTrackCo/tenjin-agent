import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPublish, type PublishArgs, type PublishDeps } from './publish';
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

function baseArgs(file: string, over: Partial<PublishArgs> = {}): PublishArgs {
  return { file, ...over };
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
      const { provider } = spyProvider();
      const deps: PublishDeps = { fetchImpl: fetch, provider };
      const args = baseArgs(file, { mode: c.mode, ...(c.yes ? { yes: true } : {}) });

      if (c.want === 'success') {
        const res = await runPublish(args, makeCtx(), deps);
        expect((res.data as { resourceId: string }).resourceId).toBe(CREATED.id);
        expect(calls).toHaveLength(1);
      } else {
        await expect(runPublish(args, makeCtx(), deps)).rejects.toMatchObject({ code: c.want });
        expect(calls).toHaveLength(0); // a refused publish never writes
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
    const deps = { fetchImpl: fetch, provider };
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
    const res = await runPublish(baseArgs(file), makeCtx(), { fetchImpl: fetch, provider });
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
    const res = await runPublish(baseArgs(await writeDoc(CLEAN)), makeCtx(), {
      fetchImpl: fetch,
      provider,
    });
    expect((res.data as { cacheEligible: boolean }).cacheEligible).toBe(false);
    expect((res.data as { missing: string[] }).missing).toEqual([]);
  });
});

describe('runPublish — session key mint-once', () => {
  it('the first publish mints the session (one wallet sig); the second reuses it (zero)', async () => {
    const { provider, signCount } = spyProvider();
    const { fetch } = stubServer();
    const deps = { fetchImpl: fetch, provider };

    await runPublish(baseArgs(await writeDoc(CLEAN)), makeCtx(), deps);
    expect(signCount()).toBe(1);

    await runPublish(baseArgs(await writeDoc(CLEAN)), makeCtx(), deps);
    expect(signCount()).toBe(1); // cached session.json reused, no second popup
  });

  it('the plain-SIWX fallback signs each write with the wallet (no session cached)', async () => {
    const { provider, signCount } = spyProvider();
    const { fetch } = stubServer();
    const deps = { fetchImpl: fetch, provider, useSession: false };

    await runPublish(baseArgs(await writeDoc(CLEAN)), makeCtx(), deps);
    await runPublish(baseArgs(await writeDoc(CLEAN)), makeCtx(), deps);
    expect(signCount()).toBe(2); // one SIWX signature per write
  });
});

describe('runPublish — the needs_confirmation payload', () => {
  it('carries mode, price, findings, card completeness, and the target', async () => {
    const file = await writeDoc(WARN);
    const { provider } = spyProvider();
    const { fetch } = stubServer();
    try {
      await runPublish(baseArgs(file, { mode: 'auto' }), makeCtx(), { fetchImpl: fetch, provider });
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
