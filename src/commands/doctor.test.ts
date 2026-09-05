import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { isNoWalletCheck, runDoctor } from './doctor';
import type { CheckResult } from './doctor';
import { getUsdcBalance } from '../lib/usdc';
import { CliError } from '../lib/errors';
import { claudeSettingsPath, FREE_VERB_RULES, MODE_GATED_RULES } from '../lib/harness-permissions';
import { emitFailure } from '../lib/output';
import { fakeRecord } from '../lib/wallet/test-support';
import { ALWAYS_SAFE_ALLOWLIST, OPT_IN_ALLOWLIST, PERMISSIONS_DOC_URL } from '../lib/permissions';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';
import { saveSessionFile } from '../lib/session-key';
import { sessionPath } from '../lib/paths';
import { testSessionKey } from '../lib/read-test-utils';
import type { WalletProvider } from '../lib/wallet';

// doctor loads viem's balance read lazily; the mock keeps every test off-chain.
vi.mock('../lib/usdc', () => ({ getUsdcBalance: vi.fn() }));
const balanceMock = vi.mocked(getUsdcBalance);

const OPENAPI_OK = {
  openapi: '3.1.0',
  info: { title: 'Tenjin', version: '0.1.0' },
  // A healthy deploy advertises the search endpoint, so the search-contract
  // check is ok (no extra fix line): "all required checks green" stays true.
  paths: { '/api/search': {} },
};
const ARTICLES_OK = { items: [{ id: 'a1' }], nextCursor: null };
// doctor reads the wallet file's cleartext top-level address without decrypting,
// so the fixture just needs a real address; PRIVATE_KEY is kept only to assert it
// never appears in any output.
const PRIVATE_KEY = `0x${'de'.repeat(32)}` as `0x${string}`;
const ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

let dir: string;
// A temp HOME for the skill-wiring check. Every runDoctor call injects it so the
// check reads a controlled tree, never the developer's real ~/.claude/skills,
// which would pass locally and warn in CI.
let skillHome: string;
// The packaged skills the freshness check compares against. `writeSkillIn`
// mirrors every fixture into it, so a test about WIRING never trips the
// stale-copy branch; the staleness tests point this at their own source instead.
let pkgSrc: string;
let prevWalletKey: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-doctor-'));
  skillHome = await mkdtemp(join(tmpdir(), 'tenjin-doctor-home-'));
  pkgSrc = await mkdtemp(join(tmpdir(), 'tenjin-doctor-pkg-'));
  balanceMock.mockReset();
  // The wallet provider resolves against process.env, so keep it hermetic: a
  // stray TENJIN_WALLET_KEY would shadow the file-based tests below.
  prevWalletKey = process.env.TENJIN_WALLET_KEY;
  delete process.env.TENJIN_WALLET_KEY;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(skillHome, { recursive: true, force: true });
  await rm(pkgSrc, { recursive: true, force: true });
  if (prevWalletKey === undefined) delete process.env.TENJIN_WALLET_KEY;
  else process.env.TENJIN_WALLET_KEY = prevWalletKey;
});

/**
 * The wallet check verifies the keystore actually decrypts (#70), which reads the
 * OS credential store. Every runDoctor below passes this so no assertion depends
 * on what is in the developer's real keychain: on a machine carrying a legacy
 * `tenjin-cli` entry the wallet checks would report differently than in CI.
 * `openbsd` is simply a platform with no built-in store, which is the state these
 * tests mean to be in — no passphrase reachable, nothing to prompt.
 */
const NO_OS_STORE = { platform: 'openbsd' } as const;

function captureIo(isTTY = false): { io: Io; stderr: () => string } {
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk([]), stderr: mk(err), isTTY };
  return { io, stderr: () => err.join('') };
}

function ctxFor(baseUrl?: string): CommandContext {
  return {
    flags: { json: false, timeout: 5000, baseUrl },
    dataDir: dir,
    io: captureIo().io,
  };
}

/** A fetch stub that routes by URL substring; a mapped Error value is thrown. */
function routeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [needle, value] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      if (value instanceof Error) throw value;
      const {
        body,
        status = 200,
        headers,
      } = value as { body: unknown; status?: number; headers?: Record<string, string> };
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        ...(headers !== undefined ? { headers } : {}),
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const healthyFetch = routeFetch({
  '/openapi.json': { body: OPENAPI_OK },
  '/api/articles': { body: ARTICLES_OK },
});

function find(checks: CheckResult[], name: string): CheckResult {
  const c = checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check named ${name}`);
  return c;
}

async function writeWallet(mode: number): Promise<void> {
  const path = join(dir, 'wallet.json');
  await writeFile(path, JSON.stringify(fakeRecord({ address: ADDRESS })));
  await chmod(path, mode);
}

describe('runDoctor — passing outcomes', () => {
  // The preflight in src/index.ts already refused anything below Node 24, so a
  // failing probe here is never "upgrade Node": the runtime is supported and the
  // import still failed, which is a damaged install or bundle (tsup once shipped
  // `import("sqlite")`, tenjin-agent#225). The remedy and the code must say so,
  // and must not collide with the preflight's NODE_UNSUPPORTED.
  it('a failing node:sqlite probe on a supported Node blames the install, not Node', async () => {
    const err = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      which: () => false,
      fetchImpl: healthyFetch,
      probeSqlite: async () => ({ ok: false, version: null }),
    }).then(
      () => {
        throw new Error('expected doctor to fail');
      },
      (e: unknown) => e as CliError,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('INTERNAL');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    const store = find(checks, 'state-store');
    expect(store.status).toBe('fail');
    expect(store.detail).toContain(`Node ${process.versions.node}`);
    expect(store.fix).toContain('Reinstall tenjin-cli');
    expect(store.fix).not.toMatch(/Node 24/);
  });

  /**
   * THE SAME ARGUMENT AS THE PROBE ABOVE, ONE STEP DOWN (#246).
   *
   * `PRAGMA journal_mode = wal` is the one statement in the store the busy
   * timeout cannot protect, so an open that loses it twice runs on against a
   * rollback journal — correct, but with the eight hooks a turn can fire now
   * serialising. `openStore` records that in one row and nothing read it, which
   * is the same invisibility the `node:sqlite` check exists to refuse.
   */
  it('reports a store stuck on a rollback journal, next to the node:sqlite line', async () => {
    const at = Date.parse('2026-08-27T09:15:00.000Z');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      which: () => false,
      fetchImpl: healthyFetch,
      readStoreJournal: async () => ({ mode: 'rollback', at }),
    });
    const checks = (res.data as { checks: CheckResult[] }).checks;
    const journal = find(checks, 'state-store-journal');
    // WARN, NEVER FAIL, and never required: degradation is not absence. The
    // store answers real counts on a rollback journal, so every bound still
    // works and doctor must not tell the operator their install is broken.
    expect(journal.status).toBe('warn');
    expect(journal.required).toBe(false);
    expect(journal.detail).toContain('rollback journal (WAL unavailable)');
    expect(journal.detail).toContain('2026-08-27T09:15:00.000Z');
    expect(journal.detail).toContain(join(dir, 'state.db'));
    expect(journal.fix).toContain('TENJIN_DATA_DIR');
    // `--json` readers get it as data, not only as prose.
    expect(journal.data).toEqual({ mode: 'rollback', at });
    // Beside the probe it belongs to, not at the bottom of the page.
    expect(checks.map((c) => c.name).indexOf('state-store-journal')).toBe(
      checks.map((c) => c.name).indexOf('state-store') + 1,
    );
  });

  /**
   * SILENT WHEN THERE IS NOTHING TO SAY. A permanently-present line about a
   * pragma that has never failed is the noise that teaches an operator to skim
   * the page, and the row self-heals, so a machine that got WAL back must stop
   * mentioning it.
   */
  it('says nothing about the journal on a store that has WAL', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      which: () => false,
      fetchImpl: healthyFetch,
      readStoreJournal: async () => ({ mode: 'wal', at: Date.now() }),
    });
    const checks = (res.data as { checks: CheckResult[] }).checks;
    expect(checks.map((c) => c.name)).not.toContain('state-store-journal');
  });

  /**
   * ...and the REAL reader, on a machine that has never run a hook. Doctor is
   * reached for when something is already broken; it may not be the thing that
   * first materialises the state database, so a missing file reads as nothing to
   * report rather than as a store to bootstrap.
   */
  it('creates no state database just to look at the journal', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      which: () => false,
      fetchImpl: healthyFetch,
    });
    const checks = (res.data as { checks: CheckResult[] }).checks;
    expect(checks.map((c) => c.name)).not.toContain('state-store-journal');
    expect(existsSync(join(dir, 'state.db'))).toBe(false);
  });

  it('all required checks green, no wallet: status pass with a warn wallet check', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'api-contract').detail).toContain('0.1.0');
    expect(find(data.checks, 'wallet').status).toBe('warn');
    // `install` suppresses this one check as a duplicate of its own wallet line,
    // and recognises it by this marker rather than by the name it shares with
    // every other wallet warning.
    expect(isNoWalletCheck(find(data.checks, 'wallet'))).toBe(true);
    expect(find(data.checks, 'search-contract').status).toBe('ok');
    // A bare temp HOME has no skills, so the wiring check warns with a fix too.
    expect(find(data.checks, 'skills').status).toBe('warn');
    // checks + a wallet-warn fix line + a skills-warn fix line, then a blank
    // separator and the one pointer line — and nothing after it (#81).
    const checkLines = data.checks.length + 2; // wallet + skills warns add a fix line each
    expect(res.humanLines?.[checkLines]).toBe('');
    expect(res.humanLines?.[checkLines + 1]).toContain(PERMISSIONS_DOC_URL);
    expect((res.humanLines ?? []).length).toBe(checkLines + 2);
  });

  // The alias is what a stale deployment advertises: it is deprecated and answers
  // 410 after one release, so a deploy carrying ONLY it is the case this check has
  // to warn about. Passing on the alias would send `tenjin search` at a path that
  // is about to stop answering, which is the entire point of the probe.
  it('search-contract warns when the deploy advertises only the deprecated alias', async () => {
    const aliasOnly = routeFetch({
      '/openapi.json': {
        body: {
          openapi: '3.1.0',
          info: { version: '0.1.0' },
          paths: { '/api/agent/search': {} },
        },
      },
      '/api/articles': { body: ARTICLES_OK },
    });
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: aliasOnly,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass'); // still passes: search-contract is not required
    const check = find(data.checks, 'search-contract');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('POST /api/search');
  });

  it('search-contract warns (never fails doctor) when the deploy omits the search path', async () => {
    const noSearch = routeFetch({
      '/openapi.json': { body: { openapi: '3.1.0', info: { version: '0.1.0' }, paths: {} } },
      '/api/articles': { body: ARTICLES_OK },
    });
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: noSearch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass'); // still passes: search-contract is not required
    expect(find(data.checks, 'search-contract').status).toBe('warn');
  });

  it('wallet present but not 0600: warns on perms, still passes', async () => {
    await writeWallet(0o644);
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    // Perms surface via the provider's diagnostics as a wallet-custody warn,
    // with the fix inline in the warning text.
    const perms = data.checks.find(
      (c) => c.name === 'wallet-custody' && c.detail.includes('chmod 600'),
    );
    expect(perms?.status).toBe('warn');
    // The private key must never reach any output field.
    expect(JSON.stringify(res.data)).not.toContain(PRIVATE_KEY);
  });

  it('env key shadows the file: env-shadow warn AND balance probes the env address', async () => {
    // Regression for the wrong-wallet bug: doctor must diagnose the ACTIVE wallet
    // (the env key), not the file it shadows. The env key derives a different
    // address than the file's, so the balance probe address proves which wins.
    await writeWallet(0o600); // file address = ADDRESS
    const envKey = generatePrivateKey();
    const envAddress = privateKeyToAccount(envKey).address;
    expect(envAddress).not.toBe(ADDRESS);
    process.env.TENJIN_WALLET_KEY = envKey; // provider reads process.env
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: { TENJIN_WALLET_KEY: envKey },
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    const shadow = data.checks.find(
      (c) => c.name === 'wallet-custody' && c.detail.includes('shadows the wallet file'),
    );
    expect(shadow?.status).toBe('warn');
    expect(find(data.checks, 'wallet').detail).toContain(envAddress);
    expect(balanceMock.mock.calls[0]?.[0]).toBe(envAddress);
  });

  it('zero balance warns with the funding fix', async () => {
    await writeWallet(0o600);
    balanceMock.mockResolvedValue(0n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const balance = find((res.data as { checks: CheckResult[] }).checks, 'balance');
    expect(balance.status).toBe('warn');
    expect(balance.fix).toContain('tenjin wallet fund');
  });

  it('a positive balance is an ok check with dual-form amount', async () => {
    await writeWallet(0o600);
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const balance = find((res.data as { checks: CheckResult[] }).checks, 'balance');
    expect(balance.status).toBe('ok');
    expect(balance.detail).toContain('5');
    expect(balance.detail).toContain('5000000');
  });

  it('an RPC failure warns, never fails doctor', async () => {
    await writeWallet(0o600);
    balanceMock.mockRejectedValue(new Error('rpc down'));
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'balance').status).toBe('warn');
  });

  it('a corrupt wallet file warns, never fails doctor', async () => {
    await writeFile(join(dir, 'wallet.json'), '{ not json');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    const wallet = find(data.checks, 'wallet');
    expect(wallet.status).toBe('warn');
    expect(wallet.detail).toContain('not valid JSON');
    // A custody problem yields no address, so no balance check is added.
    expect(data.checks.some((c) => c.name === 'balance')).toBe(false);
  });

  it('read-path probe sends no q parameter (never fabricate search demand)', async () => {
    // The server logs every nonblank first-page `q` as agent search demand, so a
    // health probe must never inject one. This assertion must never regress.
    let readPathUrl: string | undefined;
    const capturing: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/api/articles')) readPathUrl = url;
      const body = url.includes('/openapi.json') ? OPENAPI_OK : ARTICLES_OK;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: capturing,
    });
    expect(readPathUrl).toBeDefined();
    expect(new URL(readPathUrl as string).searchParams.has('q')).toBe(false);
  });

  it('every doctor check sends the tenjin-cli User-Agent and no X-Tenjin-Client', async () => {
    const headersSeen: Record<string, string>[] = [];
    const capturing: typeof fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = String(input);
      headersSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      const body = url.includes('/openapi.json') ? OPENAPI_OK : ARTICLES_OK;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: capturing,
    });
    // api-contract, search-contract, and read-path each fetch (three requests).
    expect(headersSeen.length).toBeGreaterThanOrEqual(3);
    for (const headers of headersSeen) {
      expect(headers['user-agent']).toMatch(/^tenjin-cli\//);
      expect(headers['x-tenjin-client']).toBeUndefined();
    }
  });

  /**
   * Doctor's three probes all carry the team shelf's door key, because without it
   * a protected deployment reports as unreachable. So doctor is the widest of the
   * leaks a re-pointed base URL used to open: one `--base-url` sent the key to
   * the named host three times.
   */
  describe('the team shelf bypass key on doctor probes', () => {
    const BYPASS_HEADER = 'x-vercel-protection-bypass';
    const TEAM = 'https://backtrack.tenjin.sh';
    const SECRET = 'shelf-secret-abc123';

    const checkNamed = (res: { data: unknown }, name: string): CheckResult | undefined =>
      (res.data as { checks: CheckResult[] }).checks.find((c) => c.name === name);

    async function probe(flags: { baseUrl?: string }, env: NodeJS.ProcessEnv = {}) {
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ baseUrl: TEAM, shelfBypassSecret: SECRET }),
      );
      const headersSeen: Record<string, string>[] = [];
      const capturing: typeof fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => {
        const url = String(input);
        headersSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return new Response(
          JSON.stringify(url.includes('/openapi.json') ? OPENAPI_OK : ARTICLES_OK),
          {
            status: 200,
          },
        );
      }) as typeof fetch;
      await runDoctor(
        { flags: { json: false, timeout: 5000, ...flags }, dataDir: dir, io: captureIo().io },
        {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env,
          fetchImpl: capturing,
        },
      );
      return headersSeen;
    }

    it('carries the key on the configured shelf', async () => {
      const seen = await probe({ baseUrl: undefined });
      expect(seen.length).toBeGreaterThanOrEqual(3);
      for (const headers of seen) expect(headers[BYPASS_HEADER]).toBe(SECRET);
    });

    it('reports the half-wired setup as a warn, and the finished one as ok', async () => {
      // The CLI fails a secret-with-no-shelf safe to public mode. Doctor is
      // where that silence is broken, because the operator's mental model
      // ("I am on the team shelf") is otherwise never contradicted.
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ shelfBypassSecret: SECRET, baseUrl: 'https://tenjin.blog' }),
      );
      const half = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const halfCheck = checkNamed(half, 'team shelf');
      expect(halfCheck?.status).toBe('warn');
      // Never fails the command: public mode is a working machine.
      expect(halfCheck?.required).toBe(false);
      expect(halfCheck?.detail).toContain('PUBLIC mode');
      // The secret IS configured on this run, so this can actually fail: no
      // check output anywhere in the payload may carry its value.
      expect(JSON.stringify(half.data)).not.toContain(SECRET);

      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ shelfBypassSecret: SECRET, baseUrl: TEAM }),
      );
      const done = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      expect(checkNamed(done, 'team shelf')?.status).toBe('ok');
      expect(JSON.stringify(done.data)).not.toContain(SECRET);
    });

    it('emits no team shelf check on a default machine (marketplace baseUrl, no secret)', async () => {
      const plain = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      expect(checkNamed(plain, 'team shelf')).toBeUndefined();
    });

    it('carries it on no probe when --base-url or TENJIN_BASE_URL re-points the run', async () => {
      for (const seen of [
        await probe({ baseUrl: 'https://attacker.example' }),
        await probe({ baseUrl: undefined }, { TENJIN_BASE_URL: 'https://attacker.example' }),
      ]) {
        expect(seen.length).toBeGreaterThanOrEqual(3);
        for (const headers of seen) expect(headers[BYPASS_HEADER]).toBeUndefined();
      }
    });

    it('says the key was withheld rather than claiming a team mode this run has not got', async () => {
      // The check reports what the probes DID. Re-deriving "am I in team mode"
      // from the config would have it announce a bypass header the run never
      // sent, which is the failure mode the whole check exists against.
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ shelfBypassSecret: SECRET, baseUrl: TEAM }),
      );
      const res = await runDoctor(
        {
          flags: { json: false, timeout: 5000, baseUrl: 'https://elsewhere.example' },
          dataDir: dir,
          io: captureIo().io,
        },
        {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        },
      );
      const check = checkNamed(res, 'team shelf');
      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('command-line override');
      expect(check?.detail).toContain('withheld');
      // And it never spells the flag: doctor's lines reach an unattended agent,
      // and coaching the override is the move the skills forbid (FLAG_CAVEAT).
      expect(`${check?.detail} ${check?.fix}`).not.toContain('--base-url');
      // Not the half-wired warning: the config is fine, this run is not.
      expect(check?.detail).not.toContain('PUBLIC mode');
    });

    /**
     * The mirror half of the wrong state (#218): baseUrl on a shelf of your own
     * and no secret. It is the half that breaks every probe, and it used to emit
     * no check at all, so the operator was left with a CONTRACT_MISMATCH telling
     * them to change the one setting that was right.
     */
    describe('the half-wired shelf with no secret', () => {
      async function withConfig(
        config: Record<string, unknown>,
        flags: { baseUrl?: string } = {},
        env: NodeJS.ProcessEnv = {},
      ): Promise<CheckResult | undefined> {
        await writeFile(join(dir, 'config.json'), JSON.stringify(config));
        const res = await runDoctor(
          { flags: { json: false, timeout: 5000, ...flags }, dataDir: dir, io: captureIo().io },
          {
            walletPassphrase: NO_OS_STORE,
            homeDir: skillHome,
            skillsSourceDir: pkgSrc,
            env,
            fetchImpl: healthyFetch,
          },
        );
        return checkNamed(res, 'team shelf');
      }

      it('warns when the configured baseUrl is a shelf of your own', async () => {
        const check = await withConfig({ baseUrl: TEAM });
        expect(check?.status).toBe('warn');
        // Never fails the command: an unauthenticated machine still works
        // against an unprotected shelf.
        expect(check?.required).toBe(false);
        expect(check?.detail).toContain('unauthenticated');
        // No secret is configured on this run, so asserting its absence would
        // be vacuous; the runs that configure SECRET carry that assertion.
        expect(check?.fix).toContain('shelfBypassSecret');
      });

      it('says nothing on a default machine, where baseUrl is the marketplace', async () => {
        expect(await withConfig({})).toBeUndefined();
        expect(await withConfig({ baseUrl: 'https://tenjin.blog' })).toBeUndefined();
      });

      it('says nothing when the shelf URL came from a flag or the environment', async () => {
        // This run's override, not the machine's setup. Asking for a credential
        // for an origin the flag chose is how the team key leaves the team.
        expect(await withConfig({}, { baseUrl: TEAM })).toBeUndefined();
        expect(await withConfig({}, {}, { TENJIN_BASE_URL: TEAM })).toBeUndefined();
      });
    });
  });
});

describe('runDoctor — required failures throw the mapped CliError', () => {
  async function catchDoctor(fetchImpl: typeof fetch, baseUrlFlag?: string): Promise<CliError> {
    const err = await runDoctor(ctxFor(baseUrlFlag), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }

  it('an unreachable API is API_UNREACHABLE and keeps the full check list', async () => {
    const rejecting = routeFetch({
      '/openapi.json': new TypeError('fetch failed'),
      '/api/articles': new TypeError('fetch failed'),
    });
    const err = await catchDoctor(rejecting);
    expect(err.code).toBe('API_UNREACHABLE');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    expect(find(checks, 'api-contract').status).toBe('fail');
  });

  it('a 200 with garbage JSON at openapi is CONTRACT_MISMATCH', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: 'garbage{' },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  /**
   * Same code, different cause. An access-protection page is a 200 that is not
   * JSON, so it lands on the identical branch as a broken API — and the fix line
   * that branch carried sent the operator to change `baseUrl`, which was correct
   * (#218). The transport's `gateSuspected` is what separates them.
   */
  const GATE_PAGE = routeFetch({
    '/openapi.json': {
      body: '<html><body>Authentication Required</body></html>',
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
    '/api/articles': { body: ARTICLES_OK },
  });

  it('an HTML 200 at a configured shelf points at the bypass key, not at baseUrl', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh' }),
    );
    const err = await catchDoctor(GATE_PAGE);
    expect(err.code).toBe('CONTRACT_MISMATCH');
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.detail).toContain('HTML page');
    expect(check.fix).toContain('shelfBypassSecret');
    expect(check.fix).not.toContain('config set baseUrl');
  });

  /**
   * The page is a fact about the response; whether the team key repairs it is a
   * fact about the config. On the marketplace the key is inert, and on a flag or
   * env origin it belongs to this run, so neither may be told to write one.
   */
  it('an HTML 200 from the marketplace or an override names no credential', async () => {
    for (const setup of [
      async (): Promise<CommandContext> => {
        await writeFile(join(dir, 'config.json'), JSON.stringify({}));
        return ctxFor();
      },
      async (): Promise<CommandContext> => {
        await writeFile(join(dir, 'config.json'), JSON.stringify({}));
        return {
          flags: { json: false, timeout: 5000, baseUrl: 'https://attacker.example' },
          dataDir: dir,
          io: captureIo().io,
        };
      },
    ]) {
      const ctx = await setup();
      const err = (await runDoctor(ctx, {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: GATE_PAGE,
      }).catch((e: unknown) => e)) as CliError;
      const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
      // Still names what actually came back: that part is true either way.
      expect(check.detail).toContain('HTML page');
      expect(check.fix).not.toContain('shelfBypassSecret');
      expect(check.fix).toContain('page instead of the API');
    }
  });

  /**
   * The machine that already HAS a secret must not be told to set one: the
   * probe sent the key and the gate still answered, so the key is stale or
   * rotated, and "set it" reads as "your config is fine as is". Covers all
   * three shapes a gate answers a keyed probe with (200 HTML here, 401 and the
   * 307 interstitial below).
   */
  it('a stale key that did not get past the gate says rotate, not set', async () => {
    const SECRET = 'shelf-secret-abc123';
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh', shelfBypassSecret: SECRET }),
    );
    const err = await catchDoctor(GATE_PAGE);
    expect(err.code).toBe('CONTRACT_MISMATCH');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    const check = find(checks, 'api-contract');
    expect(check.fix).toContain('stale or rotated');
    expect(check.fix).toContain('shelfBypassSecret');
    expect(check.fix).not.toContain('set the team shelf key');
    // search-contract hits the same page; its fix must not hand out a second
    // verdict ("check the base URL") beside api-contract's in --json.
    expect(find(checks, 'search-contract').fix).toContain('stale or rotated');
    // A secret is configured on this run, so this assertion can actually fail.
    expect(JSON.stringify(err.details)).not.toContain(SECRET);
  });

  /**
   * Same rejected key, named through --base-url instead of read from the file.
   * resolveShelfBypass keys on the configured and effective origins matching,
   * not on baseUrl.source, so the key IS sent here; advice that read source
   * alone told this operator to check the base URL while their key was the
   * thing being refused.
   */
  it('a repeated shelf origin via --base-url still says rotate, not check the URL', async () => {
    const SECRET = 'shelf-secret-abc123';
    const SHELF = 'https://backtrack.tenjin.sh';
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: SHELF, shelfBypassSecret: SECRET }),
    );
    const err = await catchDoctor(GATE_PAGE, SHELF);
    expect(err.code).toBe('CONTRACT_MISMATCH');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    const check = find(checks, 'api-contract');
    expect(check.fix).toContain('stale or rotated');
    expect(JSON.stringify(checks)).not.toContain(SECRET);
  });

  it('a 401 HTML page at a configured shelf with no secret says set the key', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh' }),
    );
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': {
          body: '<html><body>Authentication Required</body></html>',
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('API_UNREACHABLE');
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.detail).toContain('401');
    expect(check.detail).toContain('HTML page');
    expect(check.fix).toContain('shelfBypassSecret');
    expect(check.fix).not.toContain('config set baseUrl');
  });

  it('a redirect blocked while carrying the key gets the rotate fix, not baseUrl', async () => {
    const SECRET = 'shelf-secret-abc123';
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh', shelfBypassSecret: SECRET }),
    );
    // The keyed probe pins redirect: 'manual', so the gate's 307 interstitial
    // (a rotated bypass token's answer) surfaces as blocked-redirect.
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': {
          body: '',
          status: 307,
          headers: { location: 'https://vercel.com/sso-api?url=shelf' },
        },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('API_UNREACHABLE');
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.fix).toContain('stale or rotated');
    expect(check.fix).not.toContain('config get baseUrl');
    expect(JSON.stringify(err.details)).not.toContain(SECRET);
  });

  /**
   * A same-origin JSON 401 is NOT reclassified as a gate: an API refusing in its
   * own envelope is an honest refusal, and http.test pins `gateSuspected` false
   * on it. What changes is only the REMEDY. On a shelf of the team's own the
   * missing or stale door key is the likeliest thing being refused, and the
   * network-and-baseUrl line sent the operator to the setting that was right.
   */
  const JSON_401 = routeFetch({
    '/openapi.json': {
      body: { error: { code: 'unauthorized' } },
      status: 401,
      headers: { 'content-type': 'application/json' },
    },
    '/api/articles': { body: ARTICLES_OK },
  });

  it('a JSON 401 from a configured shelf names the key without claiming a gate page', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh' }),
    );
    const err = await catchDoctor(JSON_401);
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.fix).toContain('shelfBypassSecret');
    // The classification is untouched: nothing claims a page answered.
    expect(check.detail).not.toContain('HTML page');
    expect(check.detail).toContain('401');
  });

  it('a JSON 401 with the key already sent says rotate, not set', async () => {
    const SECRET = 'shelf-secret-abc123';
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh', shelfBypassSecret: SECRET }),
    );
    const err = await catchDoctor(JSON_401);
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.fix).toContain('stale or rotated');
    expect(JSON.stringify(err.details)).not.toContain(SECRET);
  });

  it('a JSON 401 from the marketplace keeps the ordinary advice and names no key', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({}));
    const err = await catchDoctor(JSON_401);
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.fix).not.toContain('shelfBypassSecret');
    expect(check.fix).toContain('config get baseUrl');
  });

  /**
   * The same block, from a redirect that never leaves the host asked for: an
   * `http://` baseUrl that 301s to https, a host normalising its name. The
   * transport refuses to follow any 3xx while carrying the key, so the status
   * alone is not evidence about the key, and "stale or rotated" here would blame
   * the one setting that was right (#218 inverted). `baseUrl` is what moves.
   */
  it('a same-host redirect blocked while carrying the key points at baseUrl, not at the key', async () => {
    const SECRET = 'shelf-secret-abc123';
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh', shelfBypassSecret: SECRET }),
    );
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': {
          body: '',
          status: 301,
          headers: { location: 'https://backtrack.tenjin.sh/v2/openapi.json' },
        },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('API_UNREACHABLE');
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.fix).toContain('canonical host');
    expect(check.fix).not.toContain('stale or rotated');
    expect(check.fix).not.toContain('shelfBypassSecret');
    expect(JSON.stringify(err.details)).not.toContain(SECRET);
  });

  it('a gated read path points at the key too, not only api-contract', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://backtrack.tenjin.sh' }),
    );
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: OPENAPI_OK },
        '/api/articles': {
          body: '<html><body>Authentication Required</body></html>',
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      }),
    );
    expect(err.code).toBe('API_UNREACHABLE');
    const check = find((err.details as { checks: CheckResult[] }).checks, 'read-path');
    expect(check.status).toBe('fail');
    expect(check.fix).toContain('shelfBypassSecret');
    expect(check.fix).not.toContain('config get baseUrl');
  });

  it('a plain garbage 200 still points at baseUrl, with no gate claimed', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: 'garbage{', headers: { 'content-type': 'application/json' } },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    const check = find((err.details as { checks: CheckResult[] }).checks, 'api-contract');
    expect(check.detail).toContain('was not valid JSON');
    expect(check.fix).toContain('config set baseUrl');
    expect(check.fix).not.toContain('shelfBypassSecret');
  });

  it('a missing info.version at openapi is CONTRACT_MISMATCH', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: { openapi: '3.1.0', info: { title: 'x' } } },
        '/api/articles': { body: ARTICLES_OK },
      }),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('a 500 on the read path (openapi healthy) is API_UNREACHABLE', async () => {
    const err = await catchDoctor(
      routeFetch({
        '/openapi.json': { body: OPENAPI_OK },
        '/api/articles': { body: { error: {} }, status: 500 },
      }),
    );
    expect(err.code).toBe('API_UNREACHABLE');
    const checks = (err.details as { checks: CheckResult[] }).checks;
    expect(find(checks, 'api-contract').status).toBe('ok');
    expect(find(checks, 'read-path').status).toBe('fail');
  });

  it('invalid config JSON is CONFIG_INVALID (exit 2 by default mapping)', async () => {
    await writeFile(join(dir, 'config.json'), '{ not json');
    const err = await catchDoctor(healthyFetch);
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.exitCode).toBe(2);
    const checks = (err.details as { checks: CheckResult[] }).checks;
    expect(find(checks, 'config').status).toBe('fail');
  });
});

describe('runDoctor — injected remote provider', () => {
  function remoteProvider(address: Address): WalletProvider {
    return {
      id: 'fake-remote',
      describe: async () => ({
        address,
        provider: 'fake-remote',
        credentialSource: 'remote',
        policyEnforcement: 'provider',
      }),
      diagnostics: async () => ({ warnings: [] }),
      getSigner: async () => {
        throw new Error('doctor must never acquire a signer');
      },
    };
  }

  it('empty data dir: wallet check reports the remote address, balance probes it', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
      provider: remoteProvider(address),
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'wallet').detail).toContain(address);
    expect(data.checks.filter((c) => c.name === 'wallet-custody')).toEqual([]);
    expect(balanceMock.mock.calls[0]?.[0]).toBe(address);
  });

  it('stale local wallet + env key present: no local custody state leaks into the report', async () => {
    // The contamination regression: local file with bad perms AND an env key would
    // each warn under the local provider; with a remote provider active, doctor
    // must render only that provider's diagnostics.
    await writeWallet(0o644);
    process.env.TENJIN_WALLET_KEY = generatePrivateKey();
    const address = privateKeyToAccount(generatePrivateKey()).address;
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: { TENJIN_WALLET_KEY: process.env.TENJIN_WALLET_KEY },
      fetchImpl: healthyFetch,
      provider: remoteProvider(address),
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'wallet').detail).toContain(address);
    expect(data.checks.filter((c) => c.name === 'wallet-custody')).toEqual([]);
    expect(balanceMock.mock.calls[0]?.[0]).toBe(address);
    expect(JSON.stringify(res.data)).not.toContain(PRIVATE_KEY);
  });
});

// #70: the wallet check used to pass on existence + parse + perms, so a keystore
// whose passphrase was gone read `wallet: ok` and the loss surfaced at the first
// signing. The verification itself (real scrypt, real credential store) is
// covered in lib/wallet/local.test.ts; what these pin is that doctor folds its
// verdict INTO the wallet check rather than reporting it beside a green line.
describe('runDoctor — wallet verification', () => {
  const address = privateKeyToAccount(generatePrivateKey()).address;

  function providerVerifying(verify?: WalletProvider['verify']): WalletProvider {
    return {
      id: 'fake',
      describe: async () => ({
        address,
        provider: 'fake',
        credentialSource: 'file',
        policyEnforcement: 'client-only',
      }),
      diagnostics: async () => ({ warnings: [] }),
      getSigner: async () => {
        throw new Error('doctor must never acquire a signer');
      },
      ...(verify !== undefined ? { verify } : {}),
    };
  }

  async function walletFor(verify?: WalletProvider['verify']): Promise<CheckResult> {
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
      provider: providerVerifying(verify),
    });
    return find((res.data as { checks: CheckResult[] }).checks, 'wallet');
  }

  it('is ok only when the credential is proven to sign', async () => {
    const wallet = await walletFor(async () => ({
      status: 'verified',
      detail: 'keystore decrypts',
    }));
    expect(wallet.status).toBe('ok');
    expect(wallet.detail).toContain(address);
    expect(wallet.detail).toContain('keystore decrypts');
  });

  it('warns with a fix when the keystore cannot be opened', async () => {
    const wallet = await walletFor(async () => ({
      status: 'broken',
      detail: 'the keystore cannot be decrypted',
      fix: 'Set TENJIN_WALLET_PASSPHRASE to this wallet’s passphrase.',
    }));
    expect(wallet.status).toBe('warn');
    expect(wallet.detail).toContain('cannot be decrypted');
    expect(wallet.fix).toContain('TENJIN_WALLET_PASSPHRASE');
  });

  it('says present, not verified rather than ok when it could not check', async () => {
    const wallet = await walletFor(async () => ({
      status: 'unverified',
      detail: 'no passphrase is reachable without prompting',
    }));
    expect(wallet.status).toBe('warn');
    expect(wallet.detail).toContain('present, not verified');
    expect(wallet.fix).toBeDefined();
  });

  // A provider that cannot answer without a prompt or a network call omits the
  // method; that is the unverified state, not a pass and not a failure.
  it('treats a provider with no verify as unverified', async () => {
    const wallet = await walletFor(undefined);
    expect(wallet.status).toBe('warn');
    expect(wallet.detail).toContain('present, not verified');
  });

  // doctor is diagnostics: a diagnostic that throws must not become a verdict
  // about the wallet, and must never take down the run explaining the rest.
  it('survives a provider whose verify throws', async () => {
    const wallet = await walletFor(async () => {
      throw new Error('keychain exploded');
    });
    expect(wallet.status).toBe('warn');
    expect(wallet.detail).toContain('keychain exploded');
  });

  // Never required, never a fail: `read` and `search` work without a wallet at
  // all, so an unopenable one must not change the exit code.
  it('never moves the exit code, however broken the wallet is', async () => {
    const wallet = await walletFor(async () => ({
      status: 'broken',
      detail: 'gone',
      fix: 'fix it',
    }));
    expect(wallet.required).toBe(false);
    expect(wallet.status).not.toBe('fail');
  });
});

// --- Skill wiring (#35) ------------------------------------------------------------
//
// The state this diagnoses: a machine with the hosted zero-install `tenjin` skill
// and no CLI publish skill looked identical, from the outside, to a fully wired
// one. Only a screen recording caught it. These assert the check names the state.

const claudeSkills = (): string => join(skillHome, '.claude', 'skills');
const sharedSkills = (): string => join(skillHome, '.agents', 'skills');

/** Write a SKILL.md into a skills directory, with optional frontmatter extras. */
async function writeSkillIn(dir: string, name: string, extraFrontmatter = ''): Promise<void> {
  const body = `---\nname: ${name}\ndescription: test\n${extraFrontmatter}---\n\n# ${name}\n`;
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), body);
  // Mirror into the packaged source so this fixture reads as CURRENT. FIRST write
  // wins: a name deliberately written with different content in two directories
  // must not rewrite what "packaged" means for the other one.
  await mkdir(join(pkgSrc, name), { recursive: true });
  if (!existsSync(join(pkgSrc, name, 'SKILL.md'))) {
    await writeFile(join(pkgSrc, name, 'SKILL.md'), body);
  }
}

const writeSkill = (name: string, extraFrontmatter = ''): Promise<void> =>
  writeSkillIn(claudeSkills(), name, extraFrontmatter);

/**
 * Make Codex detectable. The check only judges a directory a harness on THIS
 * machine reads: ~/.claude/skills is judged because writing a skill there creates
 * ~/.claude, and ~/.agents/skills is judged when Codex is installed (or when
 * nothing is, since it is then install's fallback target). `env: {}` everywhere
 * below means the PATH half of detection never fires, so these tests never depend
 * on whether the developer running them has claude/codex installed.
 */
const installCodex = (): Promise<string | undefined> =>
  mkdir(join(skillHome, '.codex'), { recursive: true });

describe('runDoctor — skill wiring', () => {
  it('no skills anywhere: warns and points at tenjin install', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass'); // never required: a server machine has no harness
    const skills = find(data.checks, 'skills');
    expect(skills.status).toBe('warn');
    expect(skills.required).toBe(false);
    expect(skills.detail).toContain('No Tenjin skills wired');
    expect(skills.fix).toBe('tenjin install');
  });

  it('hosted skill only: warns that both CLI skills are missing', async () => {
    await writeSkill('tenjin');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('warn');
    expect(skills.detail).toContain(
      `${claudeSkills()}: the hosted tenjin skill is here but neither CLI skill is wired`,
    );
    expect(skills.detail).toContain('hosted skill only, no CLI skills here');
    expect(skills.fix).toBe('tenjin install --harness claude');
  });

  it('hosted + search but no publish: names the directory and only the missing skill', async () => {
    await writeSkill('tenjin');
    await writeSkill('tenjin-search');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('warn');
    expect(skills.detail).toContain(`${claudeSkills()}: tenjin-publish missing`);
    expect(skills.detail).not.toContain('tenjin-search missing');
    expect(skills.fix).toBe('tenjin install --harness claude');
  });

  it('publish on disk but disable-model-invocation: reported as shadowed, not wired', async () => {
    await writeSkill('tenjin');
    await writeSkill('tenjin-search');
    await writeSkill('tenjin-publish', 'disable-model-invocation: true\n');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('warn');
    expect(skills.detail).toContain(
      `${claudeSkills()}: tenjin-publish installed but not model-invocable (disable-model-invocation: true)`,
    );
    expect(skills.detail).toContain('[disabled]');
    expect(skills.fix).toBe('tenjin install --harness claude');
  });

  it('both CLI skills wired alongside the hosted mirror: ok, and says which takes precedence', async () => {
    await writeSkill('tenjin');
    await writeSkill('tenjin-search');
    await writeSkill('tenjin-publish');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('ok');
    expect(skills.detail).toContain('tenjin-search + tenjin-publish wired');
    expect(skills.detail).toContain('CLI skills wired, take precedence over the hosted mirror');
  });

  it('reports the shared ~/.agents/skills target too, not just Claude Code', async () => {
    for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
      await writeSkillIn(sharedSkills(), name);
    }
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('ok');
    expect(skills.detail).toContain(sharedSkills());
  });

  it('an unreadable skill is not reported as disable-model-invocation', async () => {
    await writeSkill('tenjin-search');
    await writeSkill('tenjin-publish');
    await chmod(join(claudeSkills(), 'tenjin-publish', 'SKILL.md'), 0o000);
    try {
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      expect(skills.detail).toContain('unreadable or disable-model-invocation');
      expect(skills.detail).toContain('[unreadable]');
    } finally {
      await chmod(join(claudeSkills(), 'tenjin-publish', 'SKILL.md'), 0o600);
    }
  });

  it('two shadowed skills with DIFFERENT reasons are not given one merged label', async () => {
    await writeSkill('tenjin-search', 'disable-model-invocation: true\n');
    await writeSkill('tenjin-publish');
    await chmod(join(claudeSkills(), 'tenjin-publish', 'SKILL.md'), 0o000);
    try {
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      // The flagged one is a fact; only the unreadable one carries the hedge, because
      // being unable to read it is exactly why its flag cannot be asserted.
      expect(skills.detail).toContain(
        'tenjin-search installed but not model-invocable (disable-model-invocation: true)',
      );
      expect(skills.detail).toContain(
        'tenjin-publish installed but not model-invocable (unreadable or disable-model-invocation: true)',
      );
    } finally {
      await chmod(join(claudeSkills(), 'tenjin-publish', 'SKILL.md'), 0o600);
    }
  });

  it('a wired directory with no mirror does not claim precedence over one', async () => {
    await writeSkill('tenjin-search');
    await writeSkill('tenjin-publish');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('ok');
    expect(skills.detail).toContain(
      `${claudeSkills()} -> tenjin-search, tenjin-publish (CLI skills wired)`,
    );
    expect(skills.detail).not.toContain('take precedence');
  });

  // The optional tenjin-pay skill's presence must match the bazaarPay toggle:
  // install and `config set bazaarPay` place/remove it best-effort and stay
  // quiet on failure, so doctor is the one surface where the drift shows up.
  describe('bazaarPay presence-vs-toggle drift', () => {
    const wireCli = async (): Promise<void> => {
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) await writeSkill(name);
    };

    it('toggle on, skill missing: warns and coaches the re-sync', async () => {
      await wireCli();
      await writeFile(join(dir, 'config.json'), JSON.stringify({ bazaarPay: true }));
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      expect(skills.detail).toContain('bazaarPay is on but the tenjin-pay skill is missing');
      expect(skills.detail).toContain(claudeSkills());
      expect(skills.fix).toContain('tenjin config set bazaarPay on');
    });

    it('toggle off, skill still present: warns that a refused lane is being taught', async () => {
      await wireCli();
      await writeSkill('tenjin-pay'); // no config: bazaarPay defaults to off
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      expect(skills.detail).toContain('bazaarPay is off but the tenjin-pay skill is still present');
      expect(skills.fix).toContain('tenjin config set bazaarPay off');
    });

    it('toggle on with the skill present: ok', async () => {
      await wireCli();
      await writeSkill('tenjin-pay');
      await writeFile(join(dir, 'config.json'), JSON.stringify({ bazaarPay: true }));
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('ok');
    });
  });

  // Two directories in different states: the mixed case a developer with both
  // Claude Code and Codex actually hits, and the one a union across directories
  // renders as a self-contradiction.
  describe('two directories in different states', () => {
    it('wired in .claude + hosted-only leftover in .agents is ok, not "missing"', async () => {
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
        await writeSkillIn(claudeSkills(), name);
      }
      await writeSkillIn(sharedSkills(), 'tenjin');

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('ok');
      // The regression: a union across directories announced both CLI skills
      // missing in the same sentence that listed them wired.
      expect(skills.detail).not.toContain('missing');
      expect(skills.detail).toContain(
        `${claudeSkills()} -> tenjin-search, tenjin-publish, tenjin (CLI skills wired`,
      );
      expect(skills.detail).toContain(
        `${sharedSkills()} -> tenjin (hosted skill only, no CLI skills here)`,
      );
    });

    it('shadowed in one directory and missing in the other names BOTH, with both fixes', async () => {
      await installCodex();
      await writeSkillIn(claudeSkills(), 'tenjin-search');
      await writeSkillIn(claudeSkills(), 'tenjin-publish', 'disable-model-invocation: true\n');
      await writeSkillIn(sharedSkills(), 'tenjin-search');

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      // The shadowed branch used to return before missing was ever computed.
      expect(skills.detail).toContain(`${claudeSkills()}: tenjin-publish installed but not`);
      expect(skills.detail).toContain(`${sharedSkills()}: tenjin-publish missing`);
      expect(skills.fix).toBe('tenjin install --harness claude --harness shared');
    });

    it('a problem only in .agents/skills gets the --harness shared fix that can clear it', async () => {
      await installCodex();
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
        await writeSkillIn(claudeSkills(), name);
      }
      await writeSkillIn(sharedSkills(), 'tenjin-search');

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      // A bare `tenjin install` never targets ~/.agents/skills on a Claude-only
      // machine, so it would reproduce the warning forever.
      expect(skills.fix).toBe('tenjin install --harness shared');
    });

    // Unioning the SUCCESSES is the same bug as unioning the problems, inverted:
    // green on a machine where publish is genuinely unreachable from Claude Code.
    it('wired .agents does not answer for a hosted-only .claude when Claude Code is here', async () => {
      await writeSkillIn(claudeSkills(), 'tenjin'); // creates ~/.claude: Claude Code is here
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
        await writeSkillIn(sharedSkills(), name);
      }

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      expect(skills.detail).toContain(
        `${claudeSkills()}: the hosted tenjin skill is here but neither CLI skill is wired`,
      );
      // The fix must target the directory Claude Code actually reads.
      expect(skills.fix).toBe('tenjin install --harness claude');
    });

    it('an EMPTY .claude/skills with Claude Code installed is a problem too', async () => {
      await mkdir(join(skillHome, '.claude'), { recursive: true });
      await installCodex();
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
        await writeSkillIn(sharedSkills(), name);
      }

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      expect(skills.detail).toContain(`${claudeSkills()}: neither CLI skill is wired`);
      expect(skills.fix).toBe('tenjin install --harness claude');
    });

    // The mirror image: gating on detection is what keeps a leftover quiet.
    it('a half-wired .agents with no Codex is not a problem to fix', async () => {
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
        await writeSkillIn(claudeSkills(), name);
      }
      await writeSkillIn(sharedSkills(), 'tenjin-search');

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('ok');
      expect(skills.fix).toBeUndefined();
      // Still fully described, just not warned about.
      expect(skills.detail).toContain(`${sharedSkills()} -> tenjin-search (only one CLI skill)`);
    });

    // The other half of the narrowing: detection cannot see a harness the CLI does
    // not probe for, so `install --harness X` records X and doctor honours the record.
    describe('a directory an explicit --harness asked for', () => {
      /** Stand in for a past `tenjin install --harness ...` by writing what it records. */
      const recordHarness = (...harness: string[]): Promise<void> =>
        writeFile(join(dir, 'config.json'), JSON.stringify({ install: { harness } }));

      it('is judged on later runs, with a fix that names it', async () => {
        // Claude machine, no Codex, and the user chose the shared directory by hand.
        for (const name of ['tenjin-search', 'tenjin-publish']) {
          await writeSkillIn(claudeSkills(), name);
        }
        await writeSkillIn(sharedSkills(), 'tenjin-search');
        await writeSkillIn(sharedSkills(), 'tenjin-publish', 'disable-model-invocation: true\n');
        await recordHarness('shared');

        const res = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        // Before the record existed this shadowed publish skill — the #35 defect, in
        // the directory the user picked — appeared only in the "Full state" tail.
        expect(skills.status).toBe('warn');
        expect(skills.detail).toContain(
          `${sharedSkills()}: tenjin-publish installed but not model-invocable`,
        );
        expect(skills.fix).toBe('tenjin install --harness shared');
        // The healthy .claude directory is not dragged into the warning.
        expect(skills.detail).not.toContain(`${claudeSkills()}: `);
      });

      // Without the record, that shadowed skill is not what doctor warns about:
      // the #35 rule is intact. This fixture's shadowed copy also differs from the
      // packaged bytes, which the staleness branch now reports wherever it finds
      // it, because the self-heal writes to that directory too. Both claims are
      // asserted, so neither can quietly absorb the other.
      it('does not warn about the shadowed skill without the record', async () => {
        for (const name of ['tenjin-search', 'tenjin-publish']) {
          await writeSkillIn(claudeSkills(), name);
        }
        await writeSkillIn(sharedSkills(), 'tenjin-search');
        await writeSkillIn(sharedSkills(), 'tenjin-publish', 'disable-model-invocation: true\n');

        const res = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skills.detail).not.toContain('not model-invocable');
        expect(skills.detail).toContain('not from this CLI build');
        expect(skills.fix).toBe('tenjin install --harness shared');
      });

      it('rides in the data as `requested`, leaving `harnessPresent` a detection fact', async () => {
        for (const name of ['tenjin-search', 'tenjin-publish']) {
          await writeSkillIn(claudeSkills(), name);
        }
        await recordHarness('codex'); // `codex` and `shared` are the same directory

        const res = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        const dirs = (skills.data as { directories: Array<Record<string, unknown>> }).directories;
        const shared = dirs.find((d) => d.dir === sharedSkills());
        expect(shared?.requested).toBe(true);
        expect(shared?.harnessPresent).toBe(false); // no Codex here, and that stays true
        // An empty requested directory the user asked for is still the defect.
        expect(skills.status).toBe('warn');
        expect(skills.fix).toBe('tenjin install --harness shared');
      });

      it('a recorded directory that is properly wired stays quiet', async () => {
        for (const dirOf of [claudeSkills(), sharedSkills()]) {
          for (const name of ['tenjin-search', 'tenjin-publish']) await writeSkillIn(dirOf, name);
        }
        await recordHarness('shared');

        const res = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skills.status).toBe('ok');
        expect(skills.fix).toBeUndefined();
      });

      it('nothing wired anywhere: the first fix names the recorded target, not a bare tenjin install', async () => {
        // Both directories empty, but a past `install --harness shared` recorded
        // where the user wants it. Before this fix, this branch hardcoded
        // `tenjin install`, which wires .claude only; a second `doctor` run was
        // then needed to learn about --harness shared. One recorded target, one fix.
        await recordHarness('shared');

        const res = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skills.status).toBe('warn');
        expect(skills.detail).toContain('No Tenjin skills wired');
        expect(skills.fix).toBe('tenjin install --harness shared');

        // The fix clears the warning in one pass: wiring what it names is enough.
        for (const name of ['tenjin-search', 'tenjin-publish']) {
          await writeSkillIn(sharedSkills(), name);
        }
        const after = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skillsAfter = find((after.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skillsAfter.status).toBe('ok');
      });

      it('nothing wired anywhere, with a DETECTED harness alongside the recorded target: the fix names both', async () => {
        // Claude Code detected (a bare .claude dir, no skill written into it yet)
        // AND a different target recorded via a past `install --harness shared`.
        // Filtering on `requested` alone named only the recorded directory;
        // wiring it left the DETECTED .claude directory empty, and a second
        // doctor run then asked for --harness claude — two commands either way,
        // just a swapped which-directory-is-left-behind. The round-4 test above
        // could not catch this: with no `.claude` dir and `env: {}`, nothing was
        // ever detected, so filtering on `requested` alone looked sufficient.
        await mkdir(join(skillHome, '.claude'), { recursive: true });
        await recordHarness('shared');

        const res = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skills.status).toBe('warn');
        expect(skills.fix).toBe('tenjin install --harness claude --harness shared');

        // The fix clears the warning in one pass: wiring what it names, both
        // directories, is enough. Wiring only one of the two would still warn.
        for (const dirOf of [claudeSkills(), sharedSkills()]) {
          for (const name of ['tenjin-search', 'tenjin-publish']) await writeSkillIn(dirOf, name);
        }
        const after = await runDoctor(ctxFor(), {
          walletPassphrase: NO_OS_STORE,
          homeDir: skillHome,
          skillsSourceDir: pkgSrc,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skillsAfter = find((after.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skillsAfter.status).toBe('ok');
      });
    });

    it('the PATH probe detects a harness with no home dir', async () => {
      for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
        await writeSkillIn(claudeSkills(), name);
      }
      await writeSkillIn(sharedSkills(), 'tenjin');

      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        homeDir: skillHome,
        skillsSourceDir: pkgSrc,
        env: {},
        fetchImpl: healthyFetch,
        which: (bin) => bin === 'codex',
      });
      const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
      expect(skills.status).toBe('warn');
      expect(skills.fix).toBe('tenjin install --harness shared');
    });
  });

  it('--json carries the per-directory state as data, not only as prose', async () => {
    for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
      await writeSkillIn(claudeSkills(), name);
    }
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    const data = skills.data as {
      directories: Array<{
        dir: string;
        state: string;
        skills: Array<{ name: string; present: boolean; modelInvocable?: boolean }>;
      }>;
    };
    const claude = data.directories.find((d) => d.dir === claudeSkills());
    expect(claude?.state).toBe('wired');
    // The question an agent should be able to answer without parsing prose.
    const publish = claude?.skills.find((s) => s.name === 'tenjin-publish');
    expect(publish).toEqual({ name: 'tenjin-publish', present: true, modelInvocable: true });
    const shared = data.directories.find((d) => d.dir === sharedSkills());
    expect(shared?.state).toBe('empty');
  });
});

describe('runDoctor — recommended auto-mode allowlist (#33)', () => {
  it('emits the three tiers in the machine payload', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as {
      permissions: {
        alwaysSafe: { rule: string }[];
        optIn: { rule: string }[];
        neverAllowlisted: { command: string }[];
      };
    };
    expect(data.permissions.alwaysSafe.map((e) => e.rule)).toEqual(
      ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule),
    );
    expect(data.permissions.optIn.map((e) => e.rule)).toEqual([
      'Bash(tenjin buy:*)',
      'Bash(tenjin pay:*)',
      'Bash(tenjin session start:*)',
    ]);
    expect(data.permissions.neverAllowlisted.map((e) => e.command)).toContain('tenjin send');
  });

  // #81: the human render is the check list plus ONE pointer. The rules, the
  // opt-in notes, the exclusions and both caveats live on the page it points at
  // and in `--json` (asserted above), so none of them may be back in the terminal.
  it('prints no allowlist rule at all, only the pointer', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const text = (res.humanLines ?? []).join('\n');
    for (const e of [...ALWAYS_SAFE_ALLOWLIST, ...OPT_IN_ALLOWLIST]) {
      expect(text).not.toContain(e.rule);
    }
    expect(text).not.toContain('Never recommended');
    expect(text).not.toContain('mcp__tenjin__tenjin_publish');
    expect(text).toContain(PERMISSIONS_DOC_URL);
  });

  // The essay was ~60 lines above a check list of ~9. Pinned as a budget rather
  // than an exact count: what regressed here is prose creeping back in, and an
  // exact length would just be rewritten alongside it.
  it('stays within a couple of lines of the check list it was run for', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { checks: CheckResult[] };
    const fixes = data.checks.filter((c) => c.status !== 'ok' && c.fix !== undefined).length;
    // checks + their fix lines + one blank separator + the pointer.
    expect((res.humanLines ?? []).length).toBe(data.checks.length + fixes + 2);
  });
});

/**
 * The one rule doctor DOES name. An operator whose agent is being prompted for
 * every publish, on a mode that says not to ask, is reading exactly this line —
 * and the pointer, which names no rule at all, cannot tell them which one to add.
 */
describe('runDoctor — the rule the publish mode carries', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tenjin-doc-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // homeDir is threaded through so inspectFreeVerbRules reads the empty temp
  // home, not the developer's real ~/.claude/settings.json: a machine that
  // already carries the publish rules would otherwise make these cases pass or
  // fail by accident of its own config.
  const run = async (): Promise<string> => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
      homeDir: home,
      cwd: dir,
    });
    return (res.humanLines ?? []).join('\n');
  };

  it('says nothing extra on review, the shipped default', async () => {
    expect(await run()).not.toContain('Bash(tenjin publish:*)');
  });

  // The nag this line used to be: it rendered from the mode alone, so a machine
  // that already carried both rules was still told to go add them, pointing at a
  // command that would do nothing (PR #164 round 2, major 3a).
  it('says nothing when the machine already carries both rules', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'auto' } }));
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({ permissions: { allow: [...FREE_VERB_RULES, ...MODE_GATED_RULES] } }),
    );
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
      homeDir: home,
    });
    const text = (res.humanLines ?? []).join('\n');
    expect(text).not.toContain('also needs');
  });

  /**
   * An env var is per-run and settable by anything in the agent's shell, and
   * `doctor` is an allowlisted free verb — so it reports an override AS an
   * override, and never renders a `config set` built from a value it just read
   * out of the environment (PR #164 round 3, nit 1).
   */
  it('reports a TENJIN_PUBLISH_MODE override as an override, not a remedy', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: { TENJIN_PUBLISH_MODE: 'full-auto' },
      fetchImpl: healthyFetch,
      homeDir: home,
    });
    const text = (res.humanLines ?? []).join('\n');
    expect(text).toContain('TENJIN_PUBLISH_MODE=full-auto is overriding');
    expect(text).toContain('for this run only');
    expect(text).not.toContain('tenjin config set publish.mode');
    expect(text).not.toMatch(/`tenjin install` writes them/);
  });

  it('says nothing about an override on a machine that already has the rules', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({ permissions: { allow: [...FREE_VERB_RULES, ...MODE_GATED_RULES] } }),
    );
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: { TENJIN_PUBLISH_MODE: 'full-auto' },
      fetchImpl: healthyFetch,
      homeDir: home,
    });
    expect((res.humanLines ?? []).join('\n')).not.toContain('TENJIN_PUBLISH_MODE');
  });

  it('names the rule on auto', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'auto' } }));
    const text = await run();
    expect(text).toContain('Bash(tenjin publish:*)');
    expect(text).toContain('publish.mode=auto');
    // Still above the one pointer that closes every doctor run.
    expect(text.trimEnd().endsWith(PERMISSIONS_DOC_URL)).toBe(true);
  });

  it('names the rule on full-auto', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'full-auto' } }));
    expect(await run()).toContain('publish.mode=full-auto');
  });

  it('carries the mode-gated tier in --json', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'auto' } }));
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
      homeDir: home,
      cwd: dir,
    });
    const data = res.data as { permissions: { modeGated: { rule: string }[] } };
    expect(data.permissions.modeGated.map((e) => e.rule)).toEqual([
      'Bash(tenjin publish:*)',
      'Bash(tenjin edit:*)',
    ]);
  });

  it('carries an empty mode-gated tier on review', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { permissions: { modeGated: { rule: string }[] } };
    expect(data.permissions.modeGated).toEqual([]);
  });

  /**
   * PROJECT-AWARE, like `config get` and `publish`. Doctor was global-plus-env
   * only, so inside a repo pinned to `review` under a global `auto` it reported
   * the machine as needing a grant the next publish in that directory would never
   * use: three mode surfaces, three answers.
   *
   * The two controls are the point. An empty `modeGated` has to be a state this
   * path can actually produce, and a populated one has to be what a project-blind
   * read gives, or the pinned case passing proves nothing.
   */
  it('resolves the project .tenjin.json layer, like config get does', async () => {
    const modeGatedFor = async (cwd?: string): Promise<string[]> => {
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        env: {},
        fetchImpl: healthyFetch,
        ...(cwd !== undefined ? { cwd } : {}),
      });
      const data = res.data as { permissions: { modeGated: { rule: string }[] } };
      return data.permissions.modeGated.map((e) => e.rule);
    };

    const repo = await mkdtemp(join(tmpdir(), 'tenjin-doctor-proj-'));
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'auto' } }));

      // CONTROL 1: global auto with no project file still reports both rules, so
      // an empty result below is a real disagreement rather than a dead probe.
      expect(await modeGatedFor(repo)).toEqual([...MODE_GATED_RULES]);

      await writeFile(join(repo, '.tenjin.json'), JSON.stringify({ publish: { mode: 'review' } }));
      expect(await modeGatedFor(repo)).toEqual([]);

      // CONTROL 2: global review with no project file, the other way an empty
      // result is reachable.
      await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'review' } }));
      const bare = await mkdtemp(join(tmpdir(), 'tenjin-doctor-bare-'));
      try {
        await mkdir(join(bare, '.git'), { recursive: true });
        expect(await modeGatedFor(bare)).toEqual([]);
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // A project file we cannot parse is `config get`'s error to raise, not a reason
  // for every unrelated check on this page to disappear.
  it('degrades to the global mode when the project file is malformed', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tenjin-doctor-bad-'));
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      await writeFile(join(repo, '.tenjin.json'), '{ not json');
      await writeFile(join(dir, 'config.json'), JSON.stringify({ publish: { mode: 'auto' } }));
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        env: {},
        fetchImpl: healthyFetch,
        cwd: repo,
      });
      const data = res.data as { permissions: { modeGated: { rule: string }[] } };
      expect(data.permissions.modeGated.map((e) => e.rule)).toEqual([...MODE_GATED_RULES]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('runDoctor — allowlist on the failure path and terminal safety', () => {
  // The operator whose fresh install is broken is the likeliest reader of doctor
  // output, and the first cut dropped the block on exactly that path while the
  // comment beside it claimed the block rode "every doctor run".
  it('a required-check failure still carries the permissions payload', async () => {
    const brokenFetch = routeFetch({
      '/openapi.json': { body: OPENAPI_OK },
      '/api/articles': { body: { nope: true } },
    });
    const err: unknown = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: brokenFetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const details = (err as CliError).details as {
      checks: CheckResult[];
      permissions: { alwaysSafe: { rule: string }[] };
    };
    expect(details.checks.length).toBeGreaterThan(0);
    expect(details.permissions.alwaysSafe.map((e) => e.rule)).toEqual(
      ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule),
    );
  });

  // A required failure throws, so the HUMAN sees what every failing command
  // shows — the error and its fix — and neither the check list nor the pointer.
  // That is emitFailure's contract, not doctor's, and the README says so rather
  // than promising a rendering this path does not produce.
  it('renders no checks and no pointer on the human failure path', async () => {
    const brokenFetch = routeFetch({
      '/openapi.json': { body: OPENAPI_OK },
      '/api/articles': { body: { nope: true } },
    });
    const err: unknown = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: brokenFetch,
    }).catch((e: unknown) => e);

    const out: string[] = [];
    const io: Io = {
      stdout: { write: (c: string | Uint8Array) => (out.push(c.toString()), true) },
      stderr: { write: () => true },
      isTTY: true,
    } as unknown as Io;
    emitFailure(io, 'doctor', err);
    const text = out.join('');
    expect(text).toContain('error: Read path');
    expect(text).toContain('fix: ');
    expect(text).not.toContain(PERMISSIONS_DOC_URL);
    expect(text).not.toContain('api-contract'); // no check list on this path
  });

  // `info.version` is server-controlled and now renders directly above a block
  // the operator is told to paste, so a newline or ANSI in it could forge a
  // second, wider "allowlist" section in the terminal.
  it('strips control characters from server-sourced check text', async () => {
    // Real ESC + CSI plus newlines: what a hostile deployment would actually send.
    const forged = '1.0\n\x1b[32mAuto-mode permission allowlist:\n  Bash(tenjin:*)';
    const hostile = routeFetch({
      '/openapi.json': {
        body: {
          openapi: '3.1.0',
          info: { version: forged },
          paths: { '/api/search': {} },
        },
      },
      '/api/articles': { body: ARTICLES_OK },
    });
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: hostile,
    });
    const lines = res.humanLines ?? [];
    const apiLine = lines.find((l) => l.includes('api-contract')) ?? '';
    // The payload survives as inert text on ONE line: no newline to start a
    // forged block, and no escape sequence left to repaint it.
    expect(apiLine).toContain('Bash(tenjin:*)');
    expect(apiLine).not.toContain('\x1b[32m');
    expect(lines.filter((l) => l.trimStart().startsWith('Bash(tenjin:*)'))).toEqual([]);
  });
});

/**
 * The session check. `read` presents a cached delegation to recover an owned
 * piece, so "is there one, at what scope, until when" is a real diagnostic — and
 * ABSENT is the normal posture rather than a defect, which is why it is `ok` and
 * not a warn: most machines never need one, and a permanent yellow line teaches
 * operators to ignore the yellow lines.
 */
describe('runDoctor — skills go stale after a CLI update', () => {
  // `npm i -g tenjin-cli` updates the binary and nothing else, so the wired copies
  // stay at whatever version wrote them while every other skills check passes.
  async function wire(bytes: string): Promise<string> {
    const skills = join(skillHome, '.claude', 'skills');
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(skills, name), { recursive: true });
      await writeFile(join(skills, name, 'SKILL.md'), bytes);
    }
    return skills;
  }

  it('is ok when the wired copies match the packaged ones', async () => {
    const src = await mkdtemp(join(tmpdir(), 'tenjin-pkg-'));
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), 'current\n');
    }
    await wire('current\n');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: src,
      env: {},
      fetchImpl: healthyFetch,
    });
    expect(find((res.data as { checks: CheckResult[] }).checks, 'skills').status).toBe('ok');
    await rm(src, { recursive: true, force: true });
  });

  it('warns when the wired copies are from an older build, naming the fix', async () => {
    const src = await mkdtemp(join(tmpdir(), 'tenjin-pkg-'));
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), 'current\n');
    }
    const skills = await wire('what an older CLI shipped\n');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: src,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    const check = find(data.checks, 'skills');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('not from this CLI build');
    expect(check.detail).toContain(skills);
    // fixFor names the harness, so the fix actually targets the stale directory.
    expect(check.fix).toBe('tenjin install --harness claude');
    expect(data.status).toBe('pass'); // never an exit-code event
    await rm(src, { recursive: true, force: true });
  });

  // Diagnosing a broken install is doctor's job, so a package missing its skills/
  // must not be the one breakage it refuses to describe.
  it('still reports every check when the packaged skills cannot be resolved', async () => {
    const gone = join(tmpdir(), 'tenjin-nonexistent-skills-source');
    await wire('anything\n');
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: gone,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    // Every check still reported, and "cannot verify" is a warning rather than a
    // green tick: an unreadable package is exactly what doctor should describe.
    expect(data.checks.length).toBeGreaterThan(3);
    const check = find(data.checks, 'skills');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('could not be read');
    // A damaged install, not a stale one: `tenjin update` would report "up to
    // date" and do nothing, so the fix has to name a reinstall.
    expect(check.fix).toContain('npm i -g tenjin-cli');
    expect(check.fix).not.toContain('tenjin update');
  });

  // `install` writes through a symlinked directory, so a stale one is reportable
  // and the fix genuinely resolves it. (It used to be skipped, because install
  // refused to touch it and the fix could never clear.)
  it('reports a stale symlinked skill directory, whose fix now works', async () => {
    if (process.platform === 'win32') return;
    const src = await mkdtemp(join(tmpdir(), 'tenjin-pkg-'));
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), 'current\n');
    }
    await wire('current\n');
    const real = join(skillHome, 'dotfiles', 'tenjin-search');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), 'what an older CLI shipped\n');
    const link = join(skillHome, '.claude', 'skills', 'tenjin-search');
    await rm(link, { recursive: true, force: true });
    await symlink(real, link);

    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: src,
      env: {},
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('not from this CLI build');
    await rm(src, { recursive: true, force: true });
  });

  // The self-heal writes to any directory holding our adapters, whatever this
  // machine's harnesses are, and stays silent when it cannot. If staleness were
  // only reported for directories in play, ~/.agents/skills on a Claude-only
  // machine (a fallback install, then Claude Code arrives) would be a directory
  // the heal keeps rewriting and nothing ever names when that stops working.
  it('reports a stale directory no harness here reads', async () => {
    const src = await mkdtemp(join(tmpdir(), 'tenjin-pkg-'));
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), 'current\n');
    }
    // Claude is detected (its home dir is what `wire` creates) and Codex is not,
    // which is exactly what drops ~/.agents/skills out of play.
    await wire('current\n');
    const shared = join(skillHome, '.agents', 'skills');
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(shared, name), { recursive: true });
      await writeFile(join(shared, name, 'SKILL.md'), 'what an older CLI shipped\n');
    }
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: src,
      which: () => false,
      env: {},
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('not from this CLI build');
    expect(check.detail).toContain(shared);
    await rm(src, { recursive: true, force: true });
  });

  // A plain `tenjin install` targets DETECTED harnesses only, so for a directory
  // that exists because someone passed --harness it would never clear the warning.
  it('offers a harness-specific fix for a stale directory only --harness targets', async () => {
    const src = await mkdtemp(join(tmpdir(), 'tenjin-pkg-'));
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), 'current\n');
    }
    const shared = join(skillHome, '.agents', 'skills');
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      await mkdir(join(shared, name), { recursive: true });
      await writeFile(join(shared, name, 'SKILL.md'), 'what an older CLI shipped\n');
    }
    // Requested but NOT detected, which is exactly what a bare `tenjin install`
    // misses: the harness record is what put this directory in play.
    await writeFile(join(dir, 'config.json'), JSON.stringify({ install: { harness: ['codex'] } }));
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: src,
      env: {},
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('not from this CLI build');
    // Whatever fixFor names it, the point is that it is NOT the bare command,
    // which targets detected harnesses only and would never clear this warning.
    expect(check.fix).not.toBe('tenjin install');
    expect(check.fix).toContain('--harness');
    await rm(src, { recursive: true, force: true });
  });
});

describe('runDoctor — a pipe at a skill path cannot hang the diagnostic', () => {
  // `readFile` on a FIFO blocks until a writer appears, so a pipe at a wired
  // SKILL.md hung `tenjin doctor` past SIGTERM. Every read of an operator
  // controlled skill path goes through one non-blocking, fstat-checked descriptor.
  it('completes, and treats the pipe as an unusable skill rather than reading it', async () => {
    if (process.platform === 'win32') return;
    const skills = join(skillHome, '.claude', 'skills');
    await mkdir(join(skills, 'tenjin-publish'), { recursive: true });
    await writeFile(join(skills, 'tenjin-publish', 'SKILL.md'), '---\nname: tenjin-publish\n---\n');
    await mkdir(join(skills, 'tenjin-search'), { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(skills, 'tenjin-search', 'SKILL.md')]);

    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    // Reaching this line at all is the assertion: before the guard it never returned.
    const check = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(check.status).toBe('warn');
  }, 15000);
});

describe('runDoctor — session key', () => {
  it('reports ok with no session, naming the verb that would mint one', async () => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'session');
    expect(check.status).toBe('ok');
    expect(check.required).toBe(false);
    expect(check.detail).toContain('No session key');
    expect(check.detail).toContain('tenjin session start --scope read');
    expect(check.data).toBeUndefined();
  });

  it('reports a live session as ok with address, scope and expiry — never key material', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(dir, file);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'session');
    expect(check.status).toBe('ok');
    expect(check.data).toEqual({
      address: file.address,
      origin: file.origin,
      scope: 'read',
      exp: file.exp,
    });
    const rendered = JSON.stringify(res.data) + (res.humanLines ?? []).join('\n');
    expect(rendered).not.toContain(file.delegation);
    expect(rendered).not.toContain(String((file.privateKeyJwk as { d?: string }).d));
  });

  // 24h expiry is designed decay, not a fault. Warning on it made every machine
  // that ever ran `tenjin session start` permanently yellow for working as
  // intended, so a spent key reads as ok and names the verb that re-mints it.
  it('reports an expired session as ok, naming the verb that re-mints', async () => {
    const { file } = await testSessionKey({ exp: new Date(Date.now() - 1000).toISOString() });
    await saveSessionFile(dir, file);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    const check = find(data.checks, 'session');
    expect(check.status).toBe('ok');
    expect(check.required).toBe(false);
    expect(check.detail).toContain('normal after 24h');
    expect(check.detail).toContain('tenjin session start --scope read');
    // No `fix` on an ok check: the command rides the detail, as `absent` and
    // `outdated` already do.
    expect(check.fix).toBeUndefined();
    expect(data.status).toBe('pass');
  });

  // Decay is ok; a file whose expiry cannot be READ is not — that is malformed,
  // not spent, and it must not be laundered through the friendly branch.
  it('still warns when the expiry does not parse', async () => {
    const { file } = await testSessionKey({ exp: 'whenever' });
    await saveSessionFile(dir, file);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    const check = find(data.checks, 'session');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('unparseable expiry');
    expect(check.fix).toBe('tenjin session start --scope read');
    expect(data.status).toBe('pass');
  });

  // The cache an older CLI left behind. Reported as a fact about the file, not as
  // a failing check: it is unusable for the same reason an absent one is, and a
  // machine that updated should not carry a permanent warning about it.
  it('reports a pre-origin cache as ok, naming the field and the verb that re-mints', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(dir, file);
    const stale: Record<string, unknown> = { ...file };
    delete stale.origin;
    await writeFile(sessionPath(dir), JSON.stringify(stale), { mode: 0o600 });

    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    const check = find(data.checks, 'session');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('predates this CLI version');
    expect(check.detail).toContain('origin');
    expect(check.detail).toContain('tenjin session start --scope read');
    expect(check.detail).not.toContain('could not be parsed');
    expect(data.status).toBe('pass');
  });

  // A tamper signal must not be laundered through the friendly branch above.
  it('still warns when a session field is present but the wrong type', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(dir, file);
    await writeFile(sessionPath(dir), JSON.stringify({ ...file, origin: 42 }), { mode: 0o600 });

    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'session');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('could not be parsed');
  });

  // Both directions off ONE file, so the clock is provably what decides: expiry
  // is no longer a status change, so the detail is what has to carry it.
  it('uses the injected clock, so expiry is decided rather than observed', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(dir, file);
    const detailAt = async (now: () => number): Promise<string> => {
      const res = await runDoctor(ctxFor(), {
        walletPassphrase: NO_OS_STORE,
        env: {},
        fetchImpl: healthyFetch,
        now,
      });
      return find((res.data as { checks: CheckResult[] }).checks, 'session').detail;
    };
    expect(await detailAt(() => Date.parse(file.exp) + 1)).toContain('normal after 24h');
    expect(await detailAt(() => Date.parse(file.exp) - 3_600_000)).toContain(
      `Session key ${file.address}`,
    );
  });
});

/**
 * The tamper and failure states. `loadSessionFile` collapses all of these to
 * null, which is the right instruction for a caller that can re-mint and exactly
 * the wrong report for the verb an operator runs when something looks wrong: a
 * 0644 file holding a wallet-derived credential was changed out of band, and
 * "No session key" hides that.
 */
describe('runDoctor — session key, the states loadSessionFile flattens', () => {
  it('warns on a group-readable file rather than calling it absent', async () => {
    if (process.platform === 'win32') return;
    const { file } = await testSessionKey();
    await saveSessionFile(dir, file);
    await chmod(join(dir, 'session.json'), 0o644);
    const check = find(
      (
        (
          await runDoctor(ctxFor(), {
            walletPassphrase: NO_OS_STORE,
            env: {},
            fetchImpl: healthyFetch,
          })
        ).data as {
          checks: CheckResult[];
        }
      ).checks,
      'session',
    );
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('0644');
    expect(check.detail).toMatch(/out of band/i);
  });

  it('warns on a corrupt file, naming it as unparseable rather than missing', async () => {
    await writeFile(join(dir, 'session.json'), 'not json {{{', { mode: 0o600 });
    const check = find(
      (
        (
          await runDoctor(ctxFor(), {
            walletPassphrase: NO_OS_STORE,
            env: {},
            fetchImpl: healthyFetch,
          })
        ).data as {
          checks: CheckResult[];
        }
      ).checks,
      'session',
    );
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/could not be parsed/i);
  });

  it('warns when the session belongs to another origin than the configured base URL', async () => {
    const { file } = await testSessionKey({ origin: 'https://other.example' });
    await saveSessionFile(dir, file);
    const check = find(
      (
        (
          await runDoctor(ctxFor(), {
            walletPassphrase: NO_OS_STORE,
            env: {},
            fetchImpl: healthyFetch,
          })
        ).data as {
          checks: CheckResult[];
        }
      ).checks,
      'session',
    );
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('https://other.example');
    expect(check.detail).toMatch(/not presented off its own origin/i);
  });

  it('never aborts the whole run when the session cache cannot be read', async () => {
    // doctor is diagnostics. An unreadable session cache (EACCES after a `sudo`
    // run, EIO) used to throw INTERNAL out of the check array and take down the
    // one command an operator reaches for when the install is broken.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await writeFile(join(dir, 'session.json'), '{}', { mode: 0o600 });
    await chmod(join(dir, 'session.json'), 0o000);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: {},
      fetchImpl: healthyFetch,
    });
    const data = res.data as { status: string; checks: CheckResult[] };
    // Every other check still ran, and the session one warns with its fix.
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'api-contract').status).toBe('ok');
    const check = find(data.checks, 'session');
    expect(check.status).toBe('warn');
    expect(check.fix).toBe('tenjin session start --scope read');
  });
});

/**
 * The regression this round nearly shipped: `originOf` throws USAGE, and calling
 * it inline while building the check array took down the whole diagnostic before
 * a single check existed — on the one command an operator runs when the install
 * is broken, and one line above the check that had just fixed that same class.
 * The `--base-url` flag is validated at the CLI boundary; the environment and
 * config routes are not.
 */
describe('runDoctor — a base URL that is not an origin never aborts the run', () => {
  // TENJIN_BASE_URL is the live route: `--base-url` is URL-validated at the CLI
  // boundary and a bad config.json value fails the `config` check, but the env
  // var reaches settings unvalidated. This is vraspar's exact repro.
  it.each([
    ['unparseable', 'tenjin.blog'],
    ['a non-http scheme', 'foo://tenjin.blog'],
  ])('still produces a check list with %s in TENJIN_BASE_URL', async (_name, baseUrl) => {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: { TENJIN_BASE_URL: baseUrl },
      fetchImpl: healthyFetch,
    });
    const data = res.data as { checks: CheckResult[] };
    // The run produced a check list at all, which is the whole point.
    expect(data.checks.length).toBeGreaterThan(3);
    expect(find(data.checks, 'session').status).toBe('ok'); // absent, and absent is ok
  });

  it('warns that a cached session cannot be matched, instead of throwing', async () => {
    await saveSessionFile(dir, (await testSessionKey()).file);
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      env: { TENJIN_BASE_URL: 'foo://tenjin.blog' },
      fetchImpl: healthyFetch,
    });
    const check = find((res.data as { checks: CheckResult[] }).checks, 'session');
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/not an http\(s\) origin/i);
    expect(check.fix).toMatch(/config set baseUrl/);
  });
});

/**
 * The `sig_v1_test` lane (tenjin-agent#267, redesigned round 3) reads a
 * report `tenjin-vitest-reporter.mjs` wrote when one exists; this is the hint
 * that tells an operator whose project has no such reporter that they are
 * losing precision. Silent unless there is something to report, so most of
 * these assert the check is ABSENT.
 */
describe('runDoctor — test reporter hint', () => {
  async function reporterCheck(): Promise<CheckResult | undefined> {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
      cwd: dir,
    });
    return (res.data as { checks: CheckResult[] }).checks.find((c) => c.name === 'test-reporters');
  }

  it('stays quiet when the project has no vitest at all', async () => {
    expect(await reporterCheck()).toBeUndefined();
  });

  it('detects a vitest config with no tenjin reporter', async () => {
    await writeFile(
      join(dir, 'vitest.config.ts'),
      "export default { test: { environment: 'node' } };",
    );
    const check = await reporterCheck();
    expect(check?.status).toBe('warn');
    expect(check?.required).toBe(false);
    expect(check?.detail).toMatch(/vitest detected without the tenjin reporter/);
    expect(check?.fix).toContain("reporters: ['default', ['");
    expect(check?.fix).toContain('tenjin-vitest-reporter.mjs');
    expect(check?.fix).toContain("{ outputFile: '.vitest-report.json' }]]");
  });

  it('detects vitest as a bare devDependency with no config file', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: { vitest: '^2.0.0' } }),
    );
    const check = await reporterCheck();
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/vitest detected without the tenjin reporter/);
  });

  it('a vite.config.* with no test block is not read as an unconfigured vitest', async () => {
    await writeFile(join(dir, 'vite.config.ts'), 'export default { plugins: [] };');
    expect(await reporterCheck()).toBeUndefined();
  });

  it('stays quiet when the config already wires the tenjin reporter', async () => {
    await writeFile(
      join(dir, 'vitest.config.ts'),
      "export default { test: { reporters: ['default', ['/home/x/.tenjin/hooks/tenjin-vitest-reporter.mjs', { outputFile: '.vitest-report.json' }]] } };",
    );
    expect(await reporterCheck()).toBeUndefined();
  });

  // tenjin-agent#278 round 3: the stock `json` reporter carries no
  // `startTime`/`endTime`, so an artifact it writes now fails the failure
  // arm's window check outright — a config still wired to it is exactly as
  // unwired, precision-wise, as one with no reporter at all, and the hint
  // must say so rather than reading the old shape as "already fixed".
  it('still warns when the config only wires the stock json reporter, not the tenjin one', async () => {
    await writeFile(
      join(dir, 'vitest.config.ts'),
      "export default { test: { reporters: ['default', ['json', { outputFile: '.vitest-report.json' }]] } };",
    );
    const check = await reporterCheck();
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/vitest detected without the tenjin reporter/);
  });
});

/**
 * The one hook failure that is silent in the wild: the URL in settings.json
 * carries the port the daemon had bound when install ran, and a daemon that
 * later came back on another one makes every tool fire a non-blocking
 * `HTTP hook error` the operator never sees.
 */
describe('runDoctor — loop hook wiring', () => {
  async function loopCheck(): Promise<CheckResult | undefined> {
    const res = await runDoctor(ctxFor(), {
      walletPassphrase: NO_OS_STORE,
      homeDir: skillHome,
      skillsSourceDir: pkgSrc,
      env: {},
      fetchImpl: healthyFetch,
    });
    return (res.data as { checks: CheckResult[] }).checks.find((c) => c.name === 'loop hooks');
  }

  async function wireAt(port: number): Promise<void> {
    await mkdir(join(skillHome, '.claude'), { recursive: true });
    await writeFile(
      join(skillHome, '.claude', 'settings.json'),
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'http',
                    url: `http://127.0.0.1:${port}/hook/claude`,
                    headers: { Authorization: 'Bearer t' },
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  it('says nothing on a machine with no hook entries of ours', async () => {
    expect(await loopCheck()).toBeUndefined();
  });

  it('warns with "daemon not running" when nothing answers the registered port', async () => {
    await wireAt(31_999);
    const check = await loopCheck();
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('daemon not running');
    expect(check?.fix).toBe('tenjin daemon start');
  });

  it('names the port the daemon actually bound when it has moved', async () => {
    await wireAt(31_999);
    await writeFile(
      join(dir, 'daemon.pid'),
      JSON.stringify({ pid: 1, port: 32_100, started_at: 1, data_dir: dir }),
    );
    const check = await loopCheck();
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('the daemon is on port 32100 instead');
    expect(check?.fix).toBe('tenjin install');
  });

  it('warns about a settings file wider than 0600, because it carries the token', async () => {
    if (process.platform === 'win32') return;
    await wireAt(31_999);
    await chmod(join(skillHome, '.claude', 'settings.json'), 0o644);
    const check = await loopCheck();
    expect(check?.detail).toContain('wider than 0600');
  });
});
