import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { runDoctor } from './doctor';
import type { CheckResult } from './doctor';
import { getUsdcBalance } from '../lib/usdc';
import { CliError } from '../lib/errors';
import { fakeRecord } from '../lib/wallet/test-support';
import {
  ALWAYS_SAFE_ALLOWLIST,
  NEVER_ALLOWLISTED,
  OPT_IN_ALLOWLIST,
  renderPermissionsBlock,
} from '../lib/permissions';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';
import type { WalletProvider } from '../lib/wallet';

// doctor loads viem's balance read lazily; the mock keeps every test off-chain.
vi.mock('../lib/usdc', () => ({ getUsdcBalance: vi.fn() }));
const balanceMock = vi.mocked(getUsdcBalance);

const OPENAPI_OK = {
  openapi: '3.1.0',
  info: { title: 'Tenjin', version: '0.1.0' },
  // A healthy deploy advertises the A2 search endpoint, so the search-contract
  // check is ok (no extra fix line): "all required checks green" stays true.
  paths: { '/api/agent/search': {} },
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
let prevWalletKey: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-doctor-'));
  skillHome = await mkdtemp(join(tmpdir(), 'tenjin-doctor-home-'));
  balanceMock.mockReset();
  // The wallet provider resolves against process.env, so keep it hermetic: a
  // stray TENJIN_WALLET_KEY would shadow the file-based tests below.
  prevWalletKey = process.env.TENJIN_WALLET_KEY;
  delete process.env.TENJIN_WALLET_KEY;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(skillHome, { recursive: true, force: true });
  if (prevWalletKey === undefined) delete process.env.TENJIN_WALLET_KEY;
  else process.env.TENJIN_WALLET_KEY = prevWalletKey;
});

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

function ctxFor(): CommandContext {
  return {
    flags: { json: false, timeout: 5000, baseUrl: undefined },
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
      const { body, status = 200 } = value as { body: unknown; status?: number };
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
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
  it('all required checks green, no wallet: status pass with a warn wallet check', async () => {
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'api-contract').detail).toContain('0.1.0');
    expect(find(data.checks, 'wallet').status).toBe('warn');
    expect(find(data.checks, 'search-contract').status).toBe('ok');
    // A bare temp HOME has no skills, so the wiring check warns with a fix too.
    expect(find(data.checks, 'skills').status).toBe('warn');
    // checks + a wallet-warn fix line + a skills-warn fix line, then a blank
    // separator and the allowlist block. The block's own length is NOT asserted
    // against renderPermissionsBlock(): recomputing the production value on both
    // sides makes that term unfalsifiable. Pin the seam instead.
    const checkLines = data.checks.length + 2; // wallet + skills warns add a fix line each
    expect(res.humanLines?.[checkLines]).toBe('');
    expect(res.humanLines?.[checkLines + 1]).toBe(
      'Auto-mode permission allowlist (add these once, then agents stop being denied):',
    );
    expect((res.humanLines ?? []).length).toBeGreaterThan(checkLines + 20);
  });

  it('search-contract warns (never fails doctor) when the deploy omits the search path', async () => {
    const noSearch = routeFetch({
      '/openapi.json': { body: { openapi: '3.1.0', info: { version: '0.1.0' }, paths: {} } },
      '/api/articles': { body: ARTICLES_OK },
    });
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: noSearch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass'); // still passes: search-contract is not required
    expect(find(data.checks, 'search-contract').status).toBe('warn');
  });

  it('wallet present but not 0600: warns on perms, still passes', async () => {
    await writeWallet(0o644);
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
      homeDir: skillHome,
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
    const balance = find((res.data as { checks: CheckResult[] }).checks, 'balance');
    expect(balance.status).toBe('warn');
    expect(balance.fix).toContain('Send USDC on Base');
  });

  it('a positive balance is an ok check with dual-form amount', async () => {
    await writeWallet(0o600);
    balanceMock.mockResolvedValue(5_000_000n);
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
    const balance = find((res.data as { checks: CheckResult[] }).checks, 'balance');
    expect(balance.status).toBe('ok');
    expect(balance.detail).toContain('5');
    expect(balance.detail).toContain('5000000');
  });

  it('an RPC failure warns, never fails doctor', async () => {
    await writeWallet(0o600);
    balanceMock.mockRejectedValue(new Error('rpc down'));
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
    const data = res.data as { status: string; checks: CheckResult[] };
    expect(data.status).toBe('pass');
    expect(find(data.checks, 'balance').status).toBe('warn');
  });

  it('a corrupt wallet file warns, never fails doctor', async () => {
    await writeFile(join(dir, 'wallet.json'), '{ not json');
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
    await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: capturing });
    expect(readPathUrl).toBeDefined();
    expect(new URL(readPathUrl as string).searchParams.has('q')).toBe(false);
  });
});

describe('runDoctor — required failures throw the mapped CliError', () => {
  async function catchDoctor(fetchImpl: typeof fetch): Promise<CliError> {
    const err = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl }).catch(
      (e: unknown) => e,
    );
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
      homeDir: skillHome,
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
      homeDir: skillHome,
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

// --- Skill wiring (#35) ------------------------------------------------------------
//
// The state this diagnoses: a machine with the hosted zero-install `tenjin` skill
// and no CLI publish skill looked identical, from the outside, to a fully wired
// one. Only a screen recording caught it. These assert the check names the state.

const claudeSkills = (): string => join(skillHome, '.claude', 'skills');
const sharedSkills = (): string => join(skillHome, '.agents', 'skills');

/** Write a SKILL.md into a skills directory, with optional frontmatter extras. */
async function writeSkillIn(dir: string, name: string, extraFrontmatter = ''): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\n${extraFrontmatter}---\n\n# ${name}\n`,
  );
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('ok');
    expect(skills.detail).toContain('tenjin-search + tenjin-publish wired');
    expect(skills.detail).toContain('CLI skills wired, take precedence over the hosted mirror');
  });

  it('reports the shared ~/.agents/skills target too, not just Claude Code', async () => {
    for (const name of ['tenjin', 'tenjin-search', 'tenjin-publish']) {
      await writeSkillIn(sharedSkills(), name);
    }
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
        homeDir: skillHome,
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
        homeDir: skillHome,
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
    const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
    expect(skills.status).toBe('ok');
    expect(skills.detail).toContain(
      `${claudeSkills()} -> tenjin-search, tenjin-publish (CLI skills wired)`,
    );
    expect(skills.detail).not.toContain('take precedence');
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
        homeDir: skillHome,
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
        homeDir: skillHome,
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
        homeDir: skillHome,
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
        homeDir: skillHome,
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
        homeDir: skillHome,
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
        homeDir: skillHome,
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
          homeDir: skillHome,
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

      it('is the ONLY reason that state warns: no record, no warning', async () => {
        for (const name of ['tenjin-search', 'tenjin-publish']) {
          await writeSkillIn(claudeSkills(), name);
        }
        await writeSkillIn(sharedSkills(), 'tenjin-search');
        await writeSkillIn(sharedSkills(), 'tenjin-publish', 'disable-model-invocation: true\n');

        const res = await runDoctor(ctxFor(), {
          homeDir: skillHome,
          env: {},
          fetchImpl: healthyFetch,
        });
        const skills = find((res.data as { checks: CheckResult[] }).checks, 'skills');
        expect(skills.status).toBe('ok');
      });

      it('rides in the data as `requested`, leaving `harnessPresent` a detection fact', async () => {
        for (const name of ['tenjin-search', 'tenjin-publish']) {
          await writeSkillIn(claudeSkills(), name);
        }
        await recordHarness('codex'); // `codex` and `shared` are the same directory

        const res = await runDoctor(ctxFor(), {
          homeDir: skillHome,
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
          homeDir: skillHome,
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
          homeDir: skillHome,
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
          homeDir: skillHome,
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
          homeDir: skillHome,
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
          homeDir: skillHome,
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
        homeDir: skillHome,
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
    const res = await runDoctor(ctxFor(), { homeDir: skillHome, env: {}, fetchImpl: healthyFetch });
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
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
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
    expect(data.permissions.optIn.map((e) => e.rule)).toEqual(['Bash(tenjin buy:*)']);
    expect(data.permissions.neverAllowlisted.map((e) => e.command)).toContain('tenjin send');
  });

  it('prints every free-verb line, and buy only as the opt-in', async () => {
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const text = (res.humanLines ?? []).join('\n');
    for (const e of ALWAYS_SAFE_ALLOWLIST) expect(text).toContain(e.rule);
    for (const e of OPT_IN_ALLOWLIST) expect(text).toContain(e.rule);
    expect(text).toContain('Opt in separately');
    expect(text).toContain('.claude/settings.json');
  });

  it('never prints an allowlist rule for a money-moving or state-changing verb', async () => {
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: healthyFetch });
    const text = (res.humanLines ?? []).join('\n');
    for (const e of NEVER_ALLOWLISTED) {
      const verb = (e.command.split(' / ')[0] ?? e.command).replace(/^tenjin /, '');
      expect(text).not.toMatch(new RegExp(`Bash\\(tenjin ${verb}[^)]*\\)`));
    }
    // but it does name them, with the reason, so the exclusion is visible.
    expect(text).toContain('Never recommended');
    expect(text).toContain('tenjin send');
  });

  it('prints the flag caveat and the MCP caveat with the rules', () => {
    const block = renderPermissionsBlock().join('\n');
    expect(block).toContain('--base-url');
    expect(block).toContain('mcp__tenjin__tenjin_publish');
    expect(block).toContain('Free: no wallet, no signing, no payment');
    expect(block).not.toContain('free, read-only verbs');
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
    const err: unknown = await runDoctor(ctxFor(), { env: {}, fetchImpl: brokenFetch }).catch(
      (e: unknown) => e,
    );
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
          paths: { '/api/agent/search': {} },
        },
      },
      '/api/articles': { body: ARTICLES_OK },
    });
    const res = await runDoctor(ctxFor(), { env: {}, fetchImpl: hostile });
    const lines = res.humanLines ?? [];
    const apiLine = lines.find((l) => l.includes('api-contract')) ?? '';
    // The payload survives as inert text on ONE line: no newline to start a
    // forged block, and no escape sequence left to repaint it.
    expect(apiLine).toContain('Bash(tenjin:*)');
    expect(apiLine).not.toContain('\x1b[32m');
    expect(lines.filter((l) => l.trimStart().startsWith('Bash(tenjin:*)'))).toEqual([]);
  });
});
