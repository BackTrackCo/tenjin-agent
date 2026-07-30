import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionStart } from './session';
import { CliError } from '../lib/errors';
import { sessionPath } from '../lib/paths';
import { delegationResources, saveSessionFile } from '../lib/session-key';
import { loadSessionFile } from '../lib/session-present';
import { testSessionKey, testSigner } from '../lib/read-test-utils';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

/** The configured base URL every test runs against; sessions bind to its origin. */
const ORIGIN = 'https://tenjin.blog';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-session-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ORIGIN },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/**
 * A wallet provider that COUNTS the two seams separately. `describe()` reads the
 * address without touching the key; `getSigner()` is the one that unlocks it (and
 * on a real encrypted wallet, prompts). The reuse test is only meaningful if it
 * can tell those apart, so the counters are the point of this fixture.
 */
function spyProvider(signer: TenjinSigner = testSigner()): {
  provider: WalletProvider;
  signers: () => number;
  describes: () => number;
} {
  let signers = 0;
  let describes = 0;
  return {
    signers: () => signers,
    describes: () => describes,
    provider: {
      id: 'local',
      describe: async () => {
        describes++;
        return {
          address: signer.address,
          provider: 'local',
          credentialSource: 'file',
          policyEnforcement: 'client-only',
        };
      },
      getSigner: async () => {
        signers++;
        return signer;
      },
      diagnostics: async () => ({ warnings: [] }),
    },
  };
}

describe('runSessionStart mints a read-scoped session', () => {
  it('opens the wallet once and writes a 0600 read-scoped delegation', async () => {
    const spy = spyProvider();
    const before = Date.now();
    const res = await runSessionStart({}, makeCtx(), { provider: spy.provider });
    const data = res.data as { status: string; address: string; scope: string; exp: string };

    expect(data.status).toBe('created');
    expect(data.scope).toBe('read');
    expect(data.address).toBe(testSigner().address.toLowerCase());
    expect(spy.signers()).toBe(1);

    // ≤24h, and the TTL constant is what sets it (the server clamps too).
    const ttlMs = Date.parse(data.exp) - before;
    expect(ttlMs).toBeGreaterThan(23 * 3600_000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600_000 + 5000);

    const onDisk = await loadSessionFile(dir);
    expect(onDisk?.scope).toBe('read');
    if (process.platform !== 'win32') {
      expect((await stat(sessionPath(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it('binds scope `read` into the delegation the server reads, not just the file', async () => {
    const spy = spyProvider();
    await runSessionStart({ scope: 'read' }, makeCtx(), { provider: spy.provider });
    const file = await loadSessionFile(dir);
    const payload = JSON.parse(Buffer.from(file?.delegation ?? '', 'base64').toString('utf8')) as {
      resources?: string[];
    };
    // The scope URN is the server's copy of the bound. A file that said `read`
    // while the delegation said otherwise would be a client-side promise only.
    expect(payload.resources).toEqual(
      delegationResources(file?.publicKeyRaw ?? '', file?.exp ?? '', 'read'),
    );
    expect(payload.resources).toContain('urn:tenjin:session:scope:read');
  });

  it('never puts key material in the output', async () => {
    const spy = spyProvider();
    const res = await runSessionStart({}, makeCtx(), { provider: spy.provider });
    const file = await loadSessionFile(dir);
    const rendered = JSON.stringify(res.data) + (res.humanLines ?? []).join('\n');
    expect(rendered).not.toContain('privateKeyJwk');
    expect(rendered).not.toContain(file?.delegation ?? 'DELEGATION');
    expect(rendered).not.toContain(String((file?.privateKeyJwk as { d?: string }).d));
    // The three facts it DOES report.
    expect(rendered).toContain(file?.address ?? '');
    expect(rendered).toContain('read');
    expect(rendered).toContain(file?.exp ?? '');
  });
});

describe('runSessionStart is idempotent', () => {
  it('reuses a live read session without opening the wallet at all', async () => {
    const spy = spyProvider();
    await runSessionStart({}, makeCtx(), { provider: spy.provider });
    expect(spy.signers()).toBe(1);
    const first = await readFile(sessionPath(dir), 'utf8');

    const res = await runSessionStart({}, makeCtx(), { provider: spy.provider });
    expect((res.data as { status: string }).status).toBe('reused');
    // The load-bearing assertion: no SECOND wallet signature, and no second
    // keystore unlock either — describe() is enough to decide.
    expect(spy.signers()).toBe(1);
    expect(await readFile(sessionPath(dir), 'utf8')).toBe(first);
  });

  it('reuses a cached read+write session rather than downgrading it', async () => {
    const spy = spyProvider();
    const { file } = await testSessionKey({ scope: 'read+write' });
    await saveSessionFile(dir, file);

    const res = await runSessionStart({}, makeCtx(), { provider: spy.provider });
    expect(res.data).toMatchObject({ status: 'reused', scope: 'read+write' });
    expect(spy.signers()).toBe(0);
    // A `read` mint must never overwrite a wider session publish is still using.
    expect((await loadSessionFile(dir))?.scope).toBe('read+write');
  });

  it('mints again when the cached session expired', async () => {
    const spy = spyProvider();
    const { file } = await testSessionKey({ exp: new Date(Date.now() - 1000).toISOString() });
    await saveSessionFile(dir, file);
    const res = await runSessionStart({}, makeCtx(), { provider: spy.provider });
    expect((res.data as { status: string }).status).toBe('created');
    expect(spy.signers()).toBe(1);
  });

  it('mints again when the cached session belongs to another wallet', async () => {
    const spy = spyProvider();
    const { file } = await testSessionKey({ address: '0xsomeoneelse' });
    await saveSessionFile(dir, file);
    const res = await runSessionStart({}, makeCtx(), { provider: spy.provider });
    expect(res.data).toMatchObject({
      status: 'created',
      address: testSigner().address.toLowerCase(),
    });
    expect(spy.signers()).toBe(1);
  });
});

describe('v1 refuses every scope but read', () => {
  // This is what makes `Bash(tenjin session start:*)` non-escalatable: a prefix
  // rule pins the verb and not the flags, so the ONLY way the rule cannot grant a
  // write-capable delegation is for the command to refuse to mint one.
  it.each(['read+write', 'write', 'admin', 'READ', ''])(
    'refuses --scope %s as USAGE before touching the wallet',
    async (scope) => {
      const spy = spyProvider();
      const err = await runSessionStart({ scope }, makeCtx(), { provider: spy.provider }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('USAGE');
      expect((err as CliError).exitCode).toBe(2);
      // Not a signature, not even a describe(): a typo costs nothing.
      expect(spy.signers()).toBe(0);
      expect(spy.describes()).toBe(0);
      await expect(stat(sessionPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('accepts the explicit --scope read and the omitted flag alike', async () => {
    const explicit = await runSessionStart({ scope: 'read' }, makeCtx(), {
      provider: spyProvider().provider,
    });
    expect((explicit.data as { scope: string }).scope).toBe('read');
  });
});
