import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import { createLocalProvider } from '../lib/wallet/local';
import { REPAIR_CLAUSE, type UnlockReason } from '../lib/wallet-unlock';
import type { CommandContext } from '../context';
import { fakeClaude, listed, type FakeClaude } from './claude-test-utils';
import {
  doctorLines,
  findPathTenjin,
  pluginStart,
  readPluginLaunch,
  routingFeeRow,
  runRouterDoctor,
  sessionRow,
  walletRow,
  type PluginLaunch,
  type RouterDoctorDeps,
} from './doctor';
import { canPayRouting, canSign, type SignVerdict, type Verdict } from './eligibility';
import { checkEligibility, type Eligibility } from './eligibility-check';
import { LAUNCHER_MARKER, renderHostFiles } from './plugin-files';
import type { RouterCheck } from './reachability';
import type { RouterObservation } from './router-observation';
import { KEYCHAIN_LOCKED_FIX, NO_SESSION_CHECKED, WALLET_REASONS } from './wallet-reasons';

/**
 * `tenjin doctor`'s wallet, routing-fee and session rows, decided from one
 * eligibility check, and the summary that counts what to act on apart from
 * what could not be checked.
 */

const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';
const OTHER = '0x1111111111111111111111111111111111111111';
const NODE_PIN = '24.14.0';

const READY: SignVerdict = { status: 'ready', source: 'keychain' };

/** A wallet that cannot sign for `reason`, as canSign words it. */
function blockedSign(reason: UnlockReason): SignVerdict {
  return canSign({ envKey: 'absent', walletFile: 'present', unlock: { ok: false, reason } });
}

/** The routing verdict for a signer and a balance, as canPayRouting decides it. */
function routing(sign: SignVerdict, over: Partial<Parameters<typeof canPayRouting>[0]> = {}) {
  return canPayRouting({
    feeRefusal: null,
    sign,
    creditAtomic: 0n,
    depositRefusal: null,
    balanceAtomic: 10_000_000n,
    ...over,
  });
}

function eligibility(over: Partial<Eligibility> = {}): Eligibility {
  return {
    address: ADDRESS,
    source: 'keychain',
    canSign: READY,
    canPayRouting: routing(READY),
    savedSign: null,
    balanceAtomic: 10_000_000n,
    creditAtomic: 0n,
    describeError: null,
    ...over,
  };
}

function observation(over: Partial<RouterObservation> = {}): RouterObservation {
  return {
    version: 1,
    pid: 4242,
    startedAt: new Date(2026, 9, 22, 9, 5).getTime(),
    at: Date.now(),
    cliVersion: pkg.version,
    harness: 'claude',
    launchedByPlugin: true,
    cwd: '/work',
    address: ADDRESS,
    servedSession: true,
    env: { passphraseSet: false, keySet: false },
    sign: { status: 'ready', source: 'keychain' },
    ...over,
  };
}

/** Every fix must be a person's, and never steer to a secret on a line or to plaintext (B1, S3). */
function expectPersonFix(fix: string | undefined): void {
  if (fix === undefined) return;
  expect(fix).not.toMatch(/^Ask the person/);
  expect(fix).not.toContain('Set TENJIN_WALLET_PASSPHRASE');
  expect(fix).not.toContain('TENJIN_WALLET_PASSPHRASE=');
  expect(fix).not.toContain('--insecure-storage');
  for (const r of Object.values(WALLET_REASONS)) {
    if (r.agentFix !== r.fix) expect(fix).not.toBe(r.agentFix);
  }
  if (fix.includes('tenjin wallet repair')) expect(fix).toContain(REPAIR_CLAUSE);
}

describe('routingFeeRow', () => {
  it('says ready in today’s words, byte for byte, with or without credit', () => {
    const ok = {
      name: 'routing fee',
      status: 'ok',
      required: false,
      detail:
        '$0.003 a call, paid from funds set aside up to $0.25 at a time; deposits count against the spend limits',
    };
    expect(routingFeeRow({ canPayRouting: routing(READY) }, 'tenjin.sh')).toEqual(ok);
    expect(
      routingFeeRow(
        { canPayRouting: routing(READY, { creditAtomic: 250_000n, balanceAtomic: 0n }) },
        'tenjin.sh',
      ),
    ).toEqual(ok);
  });

  it('says it could not check a balance it could not read, never ok, with no fix', () => {
    const row = routingFeeRow({ canPayRouting: routing(READY, { balanceAtomic: null }) }, 'h');
    expect(row).toEqual({
      name: 'routing fee',
      status: 'warn',
      required: false,
      checked: false,
      detail: 'could not check: the wallet balance could not be read',
    });
  });

  it.each<[string, Verdict, string, string]>([
    [
      'wallet_low',
      routing(READY, { balanceAtomic: 20_000n }),
      'the wallet holds less than the $0.03 Tenjin needs to set aside for routing, so Tenjin is not routing calls',
      'Fund it with `tenjin wallet fund 5`.',
    ],
    [
      'no_wallet',
      routing(canSign({ envKey: 'absent', walletFile: 'absent' })),
      'this machine has no wallet, so Tenjin is not routing calls',
      'Run `tenjin wallet create`, then `tenjin wallet fund 5`.',
    ],
    [
      'limit_below_deposit',
      routing(READY, { depositRefusal: 'limit_below_deposit' }),
      'the per-call spend limit cannot cover the routing fee or its deposit, so Tenjin is not routing calls',
      'Raise it with `tenjin config set maxAutoSpend 0.25`.',
    ],
    [
      'budget_reached',
      routing(READY, { feeRefusal: 'budget_reached' }),
      'the daily spend limit has no room left for the routing fee or its deposit, so Tenjin is not routing calls',
      'Room comes back as the rolling day passes, or raise it with `tenjin config set sessionBudget <usd>`.',
    ],
    [
      'not_allowlisted',
      routing(READY, { feeRefusal: 'not_allowlisted' }),
      'allowlistCreators does not include the router, so Tenjin is not routing calls',
      'Add tenjin.sh to allowlistCreators, or clear the allowlist.',
    ],
  ])('names %s in today’s words and fix', (_why, verdict, detail, fix) => {
    expect(routingFeeRow({ canPayRouting: verdict }, 'tenjin.sh')).toEqual({
      name: 'routing fee',
      status: 'warn',
      required: false,
      detail,
      fix,
    });
  });

  it.each<UnlockReason>([
    'passphrase_missing',
    'passphrase_wrong',
    'env_passphrase_wrong',
    'wallet_corrupt',
  ])('gives a wallet that cannot sign (%s) the person fix', (reason) => {
    const row = routingFeeRow({ canPayRouting: routing(blockedSign(reason)) }, 'tenjin.sh');
    expect(row.status).toBe('warn');
    expect(row.detail).toBe(
      `${WALLET_REASONS[reason as keyof typeof WALLET_REASONS].reason}, so Tenjin is not routing calls`,
    );
    expect(row.fix).toBe(WALLET_REASONS[reason as keyof typeof WALLET_REASONS].fix);
    expectPersonFix(row.fix);
  });
});

/** A data dir outside home (TENJIN_DATA_DIR), so the file row shows it as is. */
const WALLET_DATA_DIR = '/srv/tenjin';
const walletRowAt = (e: Eligibility) => walletRow(e, WALLET_DATA_DIR);

describe('walletRow', () => {
  it('fails, as required, with today’s words when there is no wallet and no key', () => {
    expect(
      walletRowAt(
        eligibility({
          address: null,
          source: null,
          canSign: canSign({ envKey: 'absent', walletFile: 'absent' }),
        }),
      ),
    ).toEqual({
      name: 'wallet',
      status: 'fail',
      required: true,
      detail: 'no wallet on this machine, so nothing can pay',
      fix: 'Run `tenjin wallet create`, then `tenjin wallet fund 5`.',
    });
  });

  it('fails a wallet.json describe cannot read with its own message, as required (S11)', () => {
    const err = new CliError('CONFIG_INVALID', 'The wallet file is not valid JSON.', {
      fix: 'Restore it from a backup.',
    });
    expect(walletRowAt(eligibility({ describeError: err, canSign: READY }))).toEqual({
      name: 'wallet',
      status: 'fail',
      required: true,
      detail: 'The wallet file is not valid JSON.',
      fix: 'Restore it from a backup.',
    });
  });

  it('fails an invalid TENJIN_WALLET_KEY as required', () => {
    const row = walletRowAt(
      eligibility({ canSign: canSign({ envKey: 'malformed', walletFile: 'absent' }) }),
    );
    expect(row).toMatchObject({ status: 'fail', required: true });
    expectPersonFix(row.fix);
  });

  it.each<[string, string]>([
    ['keychain', 'macOS keychain'],
    ['secret-service', 'Linux keyring'],
    ['dpapi', 'DPAPI file'],
    ['file', `passphrase file ${WALLET_DATA_DIR}/passphrase.${ADDRESS.toLowerCase()}.plain`],
    ['key-env', 'TENJIN_WALLET_KEY in this shell'],
    ['passphrase-env', 'TENJIN_WALLET_PASSPHRASE in this shell'],
    ['legacy', 'legacy keychain entry'],
  ])('passes a wallet that unlocks from %s', (source, where) => {
    expect(
      walletRowAt(eligibility({ canSign: { status: 'ready', source: source as 'keychain' } })),
    ).toEqual({
      name: 'wallet',
      status: 'ok',
      required: true,
      detail: `${ADDRESS} unlocks without a prompt (${where})`,
    });
  });

  it('passes TENJIN_WALLET_KEY alone', () => {
    const row = walletRowAt(
      eligibility({
        source: 'key-env',
        canSign: canSign({ envKey: 'valid', walletFile: 'absent' }),
      }),
    );
    expect(row).toMatchObject({ status: 'ok', required: true });
    expect(row.detail).toContain('TENJIN_WALLET_KEY in this shell');
  });

  it('warns when the saved passphrase opened it and the variable is wrong', () => {
    expect(
      walletRowAt(
        eligibility({
          canSign: { status: 'ready', source: 'keychain', warning: 'wrong' },
        }),
      ),
    ).toEqual({
      name: 'wallet',
      status: 'warn',
      required: false,
      detail: `${ADDRESS} unlocks with the saved passphrase; TENJIN_WALLET_PASSPHRASE is set but wrong`,
      fix: 'Remove it from this shell and your shell profile: `unset TENJIN_WALLET_PASSPHRASE`.',
    });
  });

  it.each<UnlockReason>([
    'passphrase_missing',
    'passphrase_wrong',
    'env_passphrase_wrong',
    'wallet_corrupt',
  ])(
    'warns, never fails, about a wallet that cannot be unlocked (%s), with the person fix',
    (reason) => {
      const entry = WALLET_REASONS[reason as keyof typeof WALLET_REASONS];
      const row = walletRowAt(eligibility({ canSign: blockedSign(reason) }));
      expect(row).toEqual({
        name: 'wallet',
        status: 'warn',
        required: false,
        detail: `${ADDRESS} cannot be unlocked: ${entry.reason}`,
        fix: entry.fix,
      });
      expectPersonFix(row.fix);
    },
  );

  it('says a keychain that did not answer could not be checked, with the unlock fix', () => {
    const row = walletRowAt(eligibility({ canSign: blockedSign('keychain_locked') }));
    expect(row).toMatchObject({
      status: 'warn',
      required: false,
      checked: false,
      fix: KEYCHAIN_LOCKED_FIX,
    });
    expect(row.detail).toMatch(new RegExp(`^could not check whether ${ADDRESS} unlocks: `));
  });

  it('says any other unknown could not be checked, with no fix', () => {
    const row = walletRowAt(eligibility({ canSign: blockedSign('unlock_timeout') }));
    expect(row).toEqual({
      name: 'wallet',
      status: 'warn',
      required: false,
      checked: false,
      detail: `could not check whether ${ADDRESS} unlocks: the unlock did not finish in time`,
    });
  });
});

describe('sessionRow', () => {
  const REPAIR_FIX = `Run \`tenjin wallet repair\` yourself to save the passphrase where every Claude Code can read it ${REPAIR_CLAUSE}.`;

  it('with none running and a ready shell, says exactly that, as not checked', () => {
    expect(sessionRow(eligibility(), [])).toEqual({
      name: 'claude session',
      status: 'warn',
      required: false,
      checked: false,
      detail: NO_SESSION_CHECKED,
    });
  });

  it('says only that none was checked when the shell is not ready either', () => {
    const row = sessionRow(
      eligibility({ canPayRouting: routing(READY, { balanceAtomic: 0n }) }),
      [],
    );
    expect(row.detail).toBe('no running Claude session checked');
  });

  it('says a Claude Code without the variable cannot unlock it when the saved stores definitely fail (S7)', () => {
    const row = sessionRow(
      eligibility({
        source: 'passphrase-env',
        canSign: { status: 'ready', source: 'passphrase-env' },
        savedSign: blockedSign('passphrase_missing'),
      }),
      [],
    );
    expect(row).toEqual({
      name: 'claude session',
      status: 'warn',
      required: false,
      detail: `${NO_SESSION_CHECKED}, and a Claude Code started without TENJIN_WALLET_PASSPHRASE cannot unlock the wallet`,
      fix: REPAIR_FIX,
    });
    expect(row.fix).toContain(REPAIR_CLAUSE);
  });

  it.each([
    ['unknown', blockedSign('keychain_locked')],
    ['not run', null],
  ])('makes no such claim when the saved-store check is %s', (_label, savedSign) => {
    const row = sessionRow(
      eligibility({
        source: 'passphrase-env',
        canSign: { status: 'ready', source: 'passphrase-env' },
        savedSign,
      }),
      [],
    );
    expect(row).toEqual({
      name: 'claude session',
      status: 'warn',
      required: false,
      checked: false,
      detail: NO_SESSION_CHECKED,
    });
  });

  it('names the variable a key-only shell needs Claude Code to have', () => {
    const row = sessionRow(
      eligibility({ source: 'key-env', canSign: { status: 'ready', source: 'key-env' } }),
      [],
    );
    expect(row.fix).toBe('Start Claude Code from a shell that sets TENJIN_WALLET_KEY.');
  });

  it('passes on what the running session’s router unlocked, and adds nothing about routing', () => {
    const row = sessionRow(eligibility(), [observation()]);
    expect(row).toEqual({
      name: 'claude session',
      status: 'ok',
      required: false,
      detail: `the router Claude Code started (pid 4242, since 09:05, v${pkg.version}) unlocked ${ADDRESS}`,
    });
    expect(row.detail).not.toContain(' and can pay routing');
  });

  it('warns with the person fix when that router could not unlock it', () => {
    const entry = WALLET_REASONS.passphrase_missing;
    const row = sessionRow(eligibility(), [
      observation({
        sign: {
          status: 'blocked',
          reason: 'passphrase_missing',
          detail: entry.reason,
          fix: entry.agentFix,
        },
      }),
    ]);
    expect(row).toEqual({
      name: 'claude session',
      status: 'warn',
      required: false,
      detail: `the router Claude Code started (pid 4242) cannot unlock the wallet: ${entry.reason}`,
      fix: entry.fix,
    });
    expectPersonFix(row.fix);
  });

  it('warns when the session’s router uses another wallet', () => {
    expect(sessionRow(eligibility(), [observation({ address: OTHER })])).toMatchObject({
      status: 'warn',
      detail: `Claude Code's router uses ${OTHER}, this shell ${ADDRESS}`,
    });
  });

  it('says not checked while the router has not tried, or could not tell', () => {
    for (const sign of [
      { status: 'pending' as const },
      { status: 'unknown' as const, reason: 'keychain_locked' },
    ]) {
      expect(sessionRow(eligibility(), [observation({ sign })])).toMatchObject({
        status: 'warn',
        checked: false,
      });
    }
  });

  it('ignores a Codex router and one that served no Claude session (B2)', () => {
    const blocked = {
      status: 'blocked' as const,
      reason: 'passphrase_missing',
      detail: 'x',
    };
    for (const obs of [
      observation({ harness: 'codex', sign: blocked }),
      observation({ servedSession: false, sign: blocked }),
    ]) {
      expect(sessionRow(eligibility(), [obs]).detail).toBe(NO_SESSION_CHECKED);
    }
  });
});

describe('pluginStart', () => {
  const INSTALLED = 1_000_000;
  const base = {
    version: '1.2.0',
    stamp: null,
    installed: INSTALLED,
    snapshot: { routers: [], claude: [] },
    live: [],
  };

  it('is proven by a stamp at or above this version', () => {
    expect(pluginStart({ ...base, stamp: { version: '1.2.0', at: 'now' } })).toBe('proven');
    expect(pluginStart({ ...base, stamp: { version: '1.3.0', at: 'now' } })).toBe('proven');
  });

  it('is proven by a served router at this version, and not by one that served nothing', () => {
    expect(pluginStart({ ...base, live: [observation({ cliVersion: '1.2.0' })] })).toBe('proven');
    expect(
      pluginStart({ ...base, live: [observation({ cliVersion: '1.2.0', servedSession: false })] }),
    ).toBe('pending');
  });

  it('is proven by a plugin router under Claude Code started since the install', () => {
    const router = { pid: 1, startedAt: INSTALLED + 1, kind: 'plugin' as const };
    expect(
      pluginStart({
        ...base,
        snapshot: { routers: [{ ...router, underClaude: true }], claude: [] },
      }),
    ).toBe('proven');
    expect(
      pluginStart({
        ...base,
        snapshot: { routers: [{ ...router, underClaude: false }], claude: [] },
      }),
    ).toBe('pending');
  });

  it('is unknown with no stamp and no process list', () => {
    expect(pluginStart({ ...base, snapshot: null })).toBe('unknown');
  });

  it('did not start when a Claude Code started since the install, and is pending otherwise', () => {
    const claude = (startedAt: number) => ({ routers: [], claude: [{ pid: 9, startedAt }] });
    expect(pluginStart({ ...base, snapshot: claude(INSTALLED + 5) })).toBe('did-not-start');
    expect(
      pluginStart({
        ...base,
        stamp: { version: '1.1.0', at: 'then' },
        snapshot: claude(INSTALLED - 5),
      }),
    ).toBe('pending');
  });
});

describe('doctorLines', () => {
  it('counts what to act on apart from what could not be checked', () => {
    const lines = doctorLines([
      { name: 'node', status: 'ok', required: true, detail: 'v24', fix: 'unused' },
      {
        name: 'routing fee',
        status: 'warn',
        required: false,
        detail: 'the wallet is low',
        fix: 'Fund it.',
      },
      {
        name: 'claude session',
        status: 'warn',
        required: false,
        checked: false,
        detail: NO_SESSION_CHECKED,
      },
    ]);
    expect(lines).toEqual([
      'ok    node: v24',
      'warn  routing fee: the wallet is low',
      '      fix: Fund it.',
      `warn  claude session: ${NO_SESSION_CHECKED}`,
      '3 checks, 1 to act on, 1 not checked.',
    ]);
  });

  it('says all pass only when every row is ok', () => {
    const ok: RouterCheck = { name: 'node', status: 'ok', required: true, detail: 'v24' };
    expect(doctorLines([ok, ok]).at(-1)).toBe('2 checks, all pass.');
    expect(doctorLines([ok, { ...ok, status: 'warn', checked: false }]).at(-1)).toBe(
      '2 checks, 0 to act on, 1 not checked.',
    );
  });
});

describe('runRouterDoctor, with its seams injected', () => {
  let root: string;
  let home: string;
  let data: string;
  let work: string;
  let fake: FakeClaude;

  const probe400 = (async () =>
    new Response('{}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'router-doctor-'));
    home = join(root, 'home');
    data = join(root, 'data');
    work = join(root, 'work');
    await mkdir(join(work, '.git'), { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(data, { recursive: true });
    fake = await fakeClaude(root);
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    vi.stubGlobal('fetch', probe400);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  function ctx(): CommandContext {
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    return {
      flags: { json: true, timeout: 5000 },
      dataDir: data,
      io: { stdout: sink(), stderr: sink(), isTTY: false },
    };
  }

  function deps(over: Partial<RouterDoctorDeps> = {}): RouterDoctorDeps {
    return {
      homeDir: home,
      cwd: work,
      env: { ...fake.env, CLAUDE_CONFIG_DIR: join(root, 'cfg') },
      nodeVersion: 'v24.0.0',
      fetchImpl: probe400,
      listProcesses: async () => ({ routers: [], claude: [] }),
      installedAt: async () => 1_000,
      readObservations: async () => [],
      ...over,
    };
  }

  async function run(over: Partial<RouterDoctorDeps> = {}) {
    const out = await runRouterDoctor(ctx(), deps(over)).catch((e: unknown) => e);
    const checks =
      out instanceof CliError
        ? (out.details as { checks: RouterCheck[] }).checks
        : (out as { data: { checks: RouterCheck[] } }).data.checks;
    return { out, checks, by: Object.fromEntries(checks.map((c) => [c.name, c])) };
  }

  it('a fresh unfunded install has exactly one row to act on: the routing fee', async () => {
    const low = routing(READY, { balanceAtomic: 0n });
    const { out, checks, by } = await run({
      eligibility: async () => eligibility({ canPayRouting: low, balanceAtomic: 0n }),
    });
    expect(out).not.toBeInstanceOf(CliError);
    const act = checks.filter((c) => c.status !== 'ok' && c.checked !== false);
    expect(act.map((c) => c.name)).toEqual(['routing fee']);
    expect(by['routing fee']).toMatchObject({
      detail:
        'the wallet holds less than the $0.03 Tenjin needs to set aside for routing, so Tenjin is not routing calls',
      fix: 'Fund it with `tenjin wallet fund 5`.',
    });
    expect((out as { humanLines: string[] }).humanLines.at(-1)).toBe(
      `${checks.length} checks, 1 to act on, 1 not checked.`,
    );
  });

  it('uses the real session after reload instead of a failing standalone MCP probe', async () => {
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const live = observation({ cwd: work });
    const { out, by } = await run({
      eligibility: async () => eligibility(),
      readObservations: async () => [live],
      listProcesses: async () => ({
        routers: [{ pid: live.pid, startedAt: live.startedAt, kind: 'plugin', underClaude: true }],
        claude: [],
      }),
    });
    expect(out).not.toBeInstanceOf(CliError);
    expect(by['router server']).toMatchObject({ status: 'ok' });
    expect(by['router server']?.detail).toContain('serving a Claude Code session');
    expect((await fake.calls()).filter((c) => c.startsWith('mcp get'))).toEqual([]);
  });

  it.each([
    { servedSession: false },
    { cliVersion: '0.0.0' },
    { cwd: '/another-project' },
    { harness: 'codex' as const },
  ])(
    'still checks the server when a router cannot prove this install is active: %j',
    async (over) => {
      await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
      const live = observation({ cwd: work, ...over });
      const { by } = await run({
        eligibility: async () => eligibility(),
        readObservations: async () => [live],
        listProcesses: async () => ({
          routers: [
            { pid: live.pid, startedAt: live.startedAt, kind: 'plugin', underClaude: true },
          ],
          claude: [],
        }),
      });
      expect(by['router server']).toMatchObject({ status: 'fail' });
      expect((await fake.calls()).some((c) => c.startsWith('mcp get'))).toBe(true);
    },
  );

  it('never throws when the eligibility check rejects: the rows say not checked', async () => {
    const { out, by } = await run({
      eligibility: async () => {
        throw new Error('boom');
      },
    });
    expect(out).not.toBeInstanceOf(Error);
    expect(by['wallet']).toMatchObject({ status: 'warn', checked: false });
    expect(by['routing fee']).toMatchObject({ status: 'warn', checked: false });
  });

  it('does not throw for a wallet that cannot be unlocked', async () => {
    const sign = blockedSign('passphrase_missing');
    const { out, by } = await run({
      eligibility: async () =>
        eligibility({ canSign: sign, canPayRouting: routing(sign), source: null }),
    });
    expect(out).not.toBeInstanceOf(Error);
    expect(by['wallet']).toMatchObject({ status: 'warn', required: false });
  });

  it('refuses a machine with no wallet in today’s words', async () => {
    const { out } = await run();
    expect(out).toBeInstanceOf(CliError);
    expect((out as CliError).code).toBe('REFUSED');
    expect((out as CliError).message).toBe('no wallet on this machine, so nothing can pay');
  });

  it('refuses a wallet.json describe cannot read with describe’s own message (S11)', async () => {
    await writeFile(join(data, 'wallet.json'), '{"not":"a wallet"}');
    const expected = (await createLocalProvider({ dir: data, env: {} })
      .describe()
      .catch((e: unknown) => e)) as CliError;
    const { out } = await run();
    expect(out).toBeInstanceOf(CliError);
    expect((out as CliError).code).toBe('REFUSED');
    expect((out as CliError).message).toBe(expected.message);
  });

  it('reports the session a served live router saw, and only that one', async () => {
    const live = observation({ pid: 777, startedAt: 5_000 });
    // A health-check router (`claude mcp get`): alive and listed under Claude,
    // so only `servedSession: false` can leave it out.
    const unserved = observation({ pid: 778, servedSession: false });
    const { by, out } = await run({
      eligibility: async () => eligibility(),
      listProcesses: async () => ({
        routers: [
          { pid: 777, startedAt: 5_000, kind: 'plugin', underClaude: true },
          { pid: 778, startedAt: unserved.startedAt, kind: 'plugin', underClaude: true },
        ],
        claude: [],
      }),
      readObservations: async () => [live, unserved],
    });
    expect(by['claude session']).toMatchObject({ status: 'ok' });
    expect(by['claude session']?.detail).toContain('(pid 777,');
    expect((out as { data: { session: { observed: RouterObservation[] } } }).data.session).toEqual({
      observed: [live],
    });
  });

  it('S7: a correct TENJIN_WALLET_PASSPHRASE the keychain also holds reads as the keychain', async () => {
    const { encryptedRecord, KNOWN_PASSPHRASE } = await import('../lib/wallet/test-support');
    const { writeWalletRecord } = await import('../lib/wallet/store');
    const { generatePrivateKey } = await import('viem/accounts');
    const record = await encryptedRecord(generatePrivateKey());
    await writeWalletRecord(data, record);
    const exec = async (file: string, args: string[]) => {
      if (file === 'security' && args[0] === 'find-generic-password') {
        return { stdout: `${KNOWN_PASSPHRASE}\n`, stderr: '' };
      }
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    const order: string[] = [];
    const { by } = await run({
      env: {
        ...fake.env,
        CLAUDE_CONFIG_DIR: join(root, 'cfg'),
        TENJIN_WALLET_PASSPHRASE: KNOWN_PASSPHRASE,
      },
      walletPassphrase: { platform: 'darwin', isTTY: false, exec },
      eligibility: async (input) => {
        expect(input.verifySaved).toBeDefined();
        const provider = input.provider!;
        const saved = input.verifySaved!;
        return checkEligibility({
          ...input,
          readBalance: async () => 10_000_000n,
          readCredit: async () => 0n,
          verifySaved: async () => {
            order.push('saved');
            return saved();
          },
          provider: {
            ...provider,
            verify: async () => {
              order.push('full');
              return provider.verify!();
            },
          },
        });
      },
    });
    expect(order).toEqual(['saved', 'full']);
    expect(by['wallet']).toMatchObject({
      status: 'ok',
      detail: `${record.address} unlocks without a prompt (macOS keychain)`,
    });
    expect(by['claude session']?.detail).not.toContain('cannot unlock');
    expect(by['claude session']?.fix).toBeUndefined();
  }, 120_000);
});

describe('the runtime rows', () => {
  let root: string;
  let home: string;
  let runtime: string;
  let fake: FakeClaude;
  const CLI = '0.1.0-alpha.32';
  const NODE = '24.14.0';

  const probe400 = (async () =>
    new Response('{}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'router-doctor-runtime-')));
    home = join(root, 'home');
    runtime = join(home, '.tenjin', 'runtime');
    await mkdir(join(root, 'work', '.git'), { recursive: true });
    await mkdir(home, { recursive: true });
    fake = await fakeClaude(root);
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    vi.stubGlobal('fetch', probe400);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  const node = () => join(runtime, 'node', NODE, 'bin', 'node');
  const entry = () => join(runtime, 'versions', CLI, 'dist', 'index.js');
  const launcher = () => join(home, '.local', 'bin', 'tenjin');

  /** A runtime on disk: its state, Node, entry and launcher. */
  async function setUp(): Promise<void> {
    await mkdir(runtime, { recursive: true });
    await writeFile(
      join(runtime, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        current: { cli: CLI, node: NODE },
        previous: null,
        pending: null,
      }),
    );
    for (const file of [node(), entry(), launcher()]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '');
    }
  }

  const inRuntime = (): PluginLaunch => ({
    path: join(runtime, 'claude'),
    source: 'marketplace',
    command: node(),
    entry: entry(),
  });

  function ctx(dataDir = join(home, '.tenjin')): CommandContext {
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    return {
      flags: { json: true, timeout: 5000 },
      dataDir,
      io: { stdout: sink(), stderr: sink(), isTTY: false },
    };
  }

  async function run(over: Partial<RouterDoctorDeps> = {}, dataDir?: string) {
    const out = await runRouterDoctor(ctx(dataDir), {
      homeDir: home,
      cwd: join(root, 'work'),
      env: {
        ...fake.env,
        PATH: `${fake.pathDir}${delimiter}${join(home, '.local', 'bin')}`,
        SHELL: '/bin/zsh',
        CLAUDE_CONFIG_DIR: join(root, 'cfg'),
      },
      nodeVersion: 'v24.0.0',
      fetchImpl: probe400,
      listProcesses: async () => ({ routers: [], claude: [] }),
      installedAt: async () => 1_000,
      readObservations: async () => [],
      eligibility: async () => eligibility(),
      readLaunch: async () => inRuntime(),
      runVersion: async () => ({ code: 0, stdout: `${CLI}\n`, stderr: '', timedOut: false }),
      pathTenjin: async () => ({ path: launcher(), marked: true, version: null, handsOff: true }),
      unpinnedPlatform: async () => null,
      ...over,
    }).catch((e: unknown) => e);
    const checks =
      out instanceof CliError
        ? (out.details as { checks: RouterCheck[] }).checks
        : (out as { data: { checks: RouterCheck[] } }).data.checks;
    return { out, checks, by: Object.fromEntries(checks.map((c) => [c.name, c])) };
  }

  const FAIL_FIX =
    "Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.";

  it('passes an absolute Node and entry that run, between the plugin and router server rows', async () => {
    await setUp();
    const { by, checks } = await run();
    expect(by['runtime']).toEqual({
      name: 'runtime',
      status: 'ok',
      required: true,
      detail: `Claude Code starts tenjin ${CLI} on Node ${NODE} from ~/.tenjin/runtime; tenjin on PATH: ~/.local/bin/tenjin`,
    });
    const names = checks.map((c) => c.name);
    expect(names.indexOf('plugin')).toBe(names.indexOf('runtime') - 1);
    expect(names.indexOf('runtime')).toBeLessThan(names.indexOf('router server'));
    expect(by['tenjin on PATH']).toBeUndefined();
  });

  it('says how the last background update ended, above the summary, information only', async () => {
    await setUp();
    const before = await run();
    const lines = () => (before.out as { humanLines: string[] }).humanLines;
    expect(lines().some((l) => l.startsWith('Auto-update:'))).toBe(false);
    await writeFile(
      join(runtime, 'auto-update.json'),
      JSON.stringify({
        finishedAt: '2026-10-21T08:00:00.000Z',
        outcome: 'updated',
        from: '0.1.0-alpha.31',
        to: CLI,
      }),
    );
    const after = await run();
    const shown = (after.out as { humanLines: string[] }).humanLines;
    expect(shown.at(-2)).toBe(`Auto-update: 2026-10-21 updated 0.1.0-alpha.31 -> ${CLI}`);
    expect(after.checks).toEqual(before.checks);
  });

  it('warns for the PATH layout, with --project in the fix for a project install', async () => {
    const npm = join(root, 'npm', 'lib', 'node_modules', 'tenjin-cli', 'dist');
    const fromPath: PluginLaunch = {
      path: join(npm, 'hosts', 'claude'),
      source: 'marketplace',
      command: 'node',
      entry: join(npm, 'index.js'),
    };
    const { by } = await run({ readLaunch: async () => fromPath });
    expect(by['runtime']).toEqual({
      name: 'runtime',
      status: 'warn',
      required: false,
      detail: `Claude Code starts Tenjin with the \`node\` on its PATH, from ${npm}, so a Node upgrade or \`npm rm -g tenjin-cli\` stops it`,
      fix: "Run `tenjin install` to move it to Tenjin's own runtime.",
    });
    const project = await run({ readLaunch: async () => fromPath, project: true });
    expect(project.by['runtime']?.fix).toBe(
      "Run `tenjin install --project` to move it to Tenjin's own runtime.",
    );
  });

  it('fails, as required, for an entry that is gone or a command that does not run', async () => {
    await setUp();
    await rm(entry());
    const missing = await run();
    expect(missing.out).toBeInstanceOf(CliError);
    expect(missing.by['runtime']).toMatchObject({ status: 'fail', required: true, fix: FAIL_FIX });
    expect((missing.out as CliError).message).toBe(missing.by['runtime']?.detail);
    await writeFile(entry(), '');
    const broken = await run({
      runVersion: async () => ({ code: 1, stdout: '', stderr: 'SyntaxError', timedOut: false }),
    });
    expect(broken.by['runtime']).toMatchObject({ status: 'fail', required: true, fix: FAIL_FIX });
    expect(broken.by['runtime']?.detail).toContain('exited 1: SyntaxError');
    const project = await run({
      project: true,
      runVersion: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }),
    });
    expect(project.by['runtime']?.fix).toBe(
      "Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction. For a project-only installation, pass `--project` to the installer from that project folder.",
    );
  });

  it('says not checked when the version run times out', async () => {
    await setUp();
    const { by } = await run({
      runVersion: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    });
    expect(by['runtime']).toMatchObject({ status: 'warn', required: false, checked: false });
  });

  it('warns when an older build moved the marketplace out of the runtime', async () => {
    await setUp();
    const npm = join(root, 'npm', 'lib', 'node_modules', 'tenjin-cli', 'dist');
    const { by } = await run({
      readLaunch: async () => ({
        path: join(npm, 'hosts', 'claude'),
        source: 'marketplace',
        command: 'node',
        entry: join(npm, 'index.js'),
      }),
    });
    expect(by['runtime']).toEqual({
      name: 'runtime',
      status: 'warn',
      required: false,
      detail: `Claude Code loads Tenjin from ${join(npm, 'hosts', 'claude')}, not Tenjin's runtime: an older tenjin-cli build registered it there`,
      fix: 'Run `tenjin install`, then start a new Claude Code session.',
    });
  });

  it('warns for a launcher that is missing, or whose folder is off PATH', async () => {
    await setUp();
    await rm(launcher());
    const missing = await run();
    expect(missing.by['runtime']).toMatchObject({
      status: 'warn',
      fix: 'Run `tenjin install` to write it.',
    });
    expect(missing.by['runtime']?.detail).toContain('~/.local/bin/tenjin is missing');
    await writeFile(launcher(), '');
    const offPath = {
      env: { ...fake.env, SHELL: '/bin/zsh', CLAUDE_CONFIG_DIR: join(root, 'cfg') },
    };
    const off = await run({ ...offPath, pathTenjin: async () => null });
    expect(off.by['runtime']).toMatchObject({
      status: 'warn',
      fix: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`,
    });
    // npm's copy still answers in a terminal and hands off, so off PATH is no finding.
    const npmCopy = join(root, 'npm', 'bin', 'tenjin');
    const viaNpm = await run({
      ...offPath,
      pathTenjin: async () => ({ path: npmCopy, marked: false, version: CLI, handsOff: true }),
    });
    expect(viaNpm.by['runtime']).toMatchObject({ status: 'ok' });
  });

  it('shows no runtime row under a non-default data dir', async () => {
    await setUp();
    const { by } = await run({}, join(root, 'profile'));
    expect(by['runtime']).toBeUndefined();
    expect(by['tenjin on PATH']).toBeUndefined();
  });

  it('names an older npm copy first on PATH, and nothing for one that hands off', async () => {
    await setUp();
    const old = join(root, 'npm', 'bin', 'tenjin');
    const { by } = await run({
      pathTenjin: async () => ({
        path: old,
        marked: false,
        version: '0.1.0-alpha.30',
        handsOff: false,
      }),
    });
    expect(by['tenjin on PATH']).toEqual({
      name: 'tenjin on PATH',
      status: 'warn',
      required: false,
      detail: `\`tenjin\` in a terminal runs tenjin-cli 0.1.0-alpha.30 at ${old}, an older build that does not hand off to Tenjin's runtime`,
      fix: 'Remove it with `npm uninstall -g tenjin-cli` using the Node that installed it, or upgrade it with `npm i -g tenjin-cli@latest`.',
    });
    const newer = await run({
      pathTenjin: async () => ({ path: old, marked: false, version: CLI, handsOff: true }),
    });
    expect(newer.by['tenjin on PATH']).toBeUndefined();
    const none = await run({ pathTenjin: async () => null });
    expect(none.by['tenjin on PATH']).toBeUndefined();
  });

  /**
   * `~/.tenjin/runtime` deleted: Claude Code still loads `runtime/claude`, now
   * empty. The runtime row fails with the reinstall that rebuilds it, and no
   * fix sends the person to the `node` on PATH or to `tenjin install`, which
   * is the broken launcher now.
   */
  it('fails, with the Node-free official installer, when the runtime folder Claude Code loads is gone', async () => {
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const { by } = await run({
      readLaunch: async () => ({
        path: join(runtime, 'claude'),
        source: 'marketplace',
        command: null,
        entry: null,
      }),
      listProcesses: async () => ({ routers: [], claude: [{ pid: 9, startedAt: 2_000 }] }),
    });
    expect(by['runtime']).toEqual({
      name: 'runtime',
      status: 'fail',
      required: true,
      detail: `Claude Code loads Tenjin from ~/.tenjin/runtime/claude, which no longer holds its plugin, so the router cannot start`,
      fix: FAIL_FIX,
    });
    const rest = [by['plugin']?.fix, by['router server']?.fix];
    expect(rest).toEqual([
      "Start a new Claude Code session. If Tenjin still does not start: Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.",
      "Start a new Claude Code session. If Tenjin still does not start: Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.",
    ]);
  });

  /**
   * PR 1 or alpha.30 registered npm's folder; a Node upgrade deleted that
   * prefix, so Claude Code loads a folder that is gone, and no runtime exists
   * yet. The runtime row fails with the Node-free official installer, and nothing blames the
   * `node` on Claude Code's PATH.
   */
  it('fails, with the Node-free official installer, when the npm folder Claude Code loads is gone', async () => {
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const npm = join(root, 'old-prefix', 'lib', 'node_modules', 'tenjin-cli', 'dist');
    const gone: PluginLaunch = {
      path: join(npm, 'hosts', 'claude'),
      source: 'marketplace',
      command: null,
      entry: null,
      missing: true,
    };
    const over = {
      readLaunch: async () => gone,
      listProcesses: async () => ({ routers: [], claude: [{ pid: 9, startedAt: 2_000 }] }),
    };
    const { by, out } = await run(over);
    expect(out).toBeInstanceOf(CliError);
    expect(by['runtime']).toEqual({
      name: 'runtime',
      status: 'fail',
      required: true,
      detail: `Claude Code loads Tenjin from ${join(npm, 'hosts', 'claude')}, which no longer holds its plugin, so the router cannot start`,
      fix: FAIL_FIX,
    });
    for (const fix of [by['plugin']?.fix, by['router server']?.fix]) {
      expect(fix).toBe(
        "Start a new Claude Code session. If Tenjin still does not start: Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.",
      );
    }
    const project = await run({ ...over, project: true });
    expect(project.by['runtime']?.fix).toBe(
      "Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction. For a project-only installation, pass `--project` to the installer from that project folder.",
    );
  });

  it('reports an older npm install on an unsupported platform without recommending another unsupported install', async () => {
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const npm = join(root, 'npm', 'lib', 'node_modules', 'tenjin-cli', 'dist');
    const unpinned = 'linux-x64 with musl, not glibc';
    const { by } = await run({
      readLaunch: async () => ({
        path: join(npm, 'hosts', 'claude'),
        source: 'marketplace',
        command: 'node',
        entry: join(npm, 'index.js'),
      }),
      unpinnedPlatform: async () => unpinned,
      listProcesses: async () => ({ routers: [], claude: [{ pid: 9, startedAt: 2_000 }] }),
    });
    expect(by['runtime']).toEqual({
      name: 'runtime',
      status: 'warn',
      required: false,
      detail: `This older installation runs from npm's copy at ${npm}; this platform (${unpinned}) does not support Tenjin's private runtime`,
      fix: 'Use macOS, Windows or glibc Linux 2.28+ on x64/arm64. This installation was left unchanged.',
    });
    for (const fix of [by['plugin']?.fix, by['router server']?.fix]) {
      expect(fix).toContain('`node`');
      expect(fix).not.toContain('own runtime');
    }
  });

  it('offers no move to the runtime under a non-default data dir, where install sets none up', async () => {
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const npm = join(root, 'npm', 'lib', 'node_modules', 'tenjin-cli', 'dist');
    const fromPath: PluginLaunch = {
      path: join(npm, 'hosts', 'claude'),
      source: 'marketplace',
      command: 'node',
      entry: join(npm, 'index.js'),
    };
    const profile = await run(
      { readLaunch: async () => fromPath, listProcesses: async () => null },
      join(root, 'profile'),
    );
    expect(profile.by['plugin']?.fix).toContain('quit Claude Code fully');
    expect(profile.by['router server']?.fix).toContain('Quit Claude Code fully');
    for (const fix of [profile.by['plugin']?.fix, profile.by['router server']?.fix]) {
      expect(fix).not.toContain('own runtime');
    }
    // The default data dir on a pinned platform still offers it.
    const home = await run({ readLaunch: async () => fromPath, listProcesses: async () => null });
    expect(home.by['router server']?.fix).toMatch(
      /Or run `tenjin install` to move Tenjin to its own runtime\.$/,
    );
  });

  it('names the first tenjin on PATH in the ok row, even one with no package identified', async () => {
    await setUp();
    const shim = join(root, 'volta', 'bin', 'tenjin');
    const { by } = await run({
      pathTenjin: async () => ({
        path: shim,
        marked: false,
        version: null,
        handsOff: false,
        unknown: true,
      }),
    });
    expect(by['runtime']).toMatchObject({ status: 'ok' });
    expect(by['runtime']?.detail).toMatch(new RegExp(`; tenjin on PATH: ${shim}$`));
    expect(by['tenjin on PATH']).toBeUndefined();
  });

  it('on the runtime layout, no fix blames the node on Claude Code’s PATH', async () => {
    await setUp();
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const unknown = await run({ listProcesses: async () => null });
    const started = await run({
      listProcesses: async () => ({ routers: [], claude: [{ pid: 9, startedAt: 2_000 }] }),
    });
    const fixes = [
      unknown.by['plugin']?.fix,
      started.by['plugin']?.fix,
      started.by['router server']?.fix,
    ];
    expect(fixes).toEqual([
      "Start a new Claude Code session and run `tenjin doctor` again: `/reload-plugins` does not run the plugin's `SessionStart`, so only a new session writes the stamp.",
      "Start a new Claude Code session. If Tenjin still does not start: Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.",
      "Start a new Claude Code session. If Tenjin still does not start: Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.",
    ]);
    for (const fix of fixes) expect(fix).not.toMatch(/node.{0,10}PATH|restart Claude Code/i);
  });
});

describe('findPathTenjin', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'path-tenjin-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A global tenjin-cli package, as npm lays it out. */
  async function npmPackage(dir: string, extra: Record<string, unknown> = {}): Promise<void> {
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.js'), '');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'tenjin-cli', version: '0.1.0-alpha.30', ...extra }),
    );
  }

  it("follows npm's POSIX link to its package, and reads whether it hands off", async () => {
    const pkgDir = join(root, 'lib', 'node_modules', 'tenjin-cli');
    await npmPackage(pkgDir);
    await mkdir(join(root, 'bin'));
    await symlink(join(pkgDir, 'dist', 'index.js'), join(root, 'bin', 'tenjin'));
    const env = { PATH: `${join(root, 'empty')}:${join(root, 'bin')}` };
    expect(await findPathTenjin(env, 'darwin')).toEqual({
      path: join(root, 'bin', 'tenjin'),
      marked: false,
      version: '0.1.0-alpha.30',
      handsOff: false,
    });
    await npmPackage(pkgDir, { tenjinRuntime: { node: { version: NODE_PIN } } });
    expect((await findPathTenjin(env, 'darwin'))?.handsOff).toBe(true);
  });

  it("reads npm's Windows shim from the package beside it", async () => {
    const dir = join(root, 'npm');
    await npmPackage(join(dir, 'node_modules', 'tenjin-cli'));
    await writeFile(join(dir, 'tenjin.cmd'), '@"%~dp0\\node_modules\\tenjin-cli\\dist\\index.js"');
    expect(await findPathTenjin({ Path: dir }, 'win32')).toMatchObject({
      path: join(dir, 'tenjin.cmd'),
      version: '0.1.0-alpha.30',
      handsOff: false,
    });
  });

  it('returns the first tenjin on PATH even when no package is behind it, ahead of a launcher', async () => {
    await mkdir(join(root, 'volta'));
    await writeFile(join(root, 'volta', 'tenjin'), '#!/bin/sh\nexec volta-shim "$@"\n');
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin', 'tenjin'), `#!/bin/sh\n# ${LAUNCHER_MARKER}\n`);
    expect(
      await findPathTenjin({ PATH: `${join(root, 'volta')}:${join(root, 'bin')}` }, 'linux'),
    ).toEqual({
      path: join(root, 'volta', 'tenjin'),
      marked: false,
      version: null,
      handsOff: false,
      unknown: true,
    });
  });

  it('takes a launcher as it is, and finds nothing on an empty PATH', async () => {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin', 'tenjin'), `#!/bin/sh\n# ${LAUNCHER_MARKER}\n`);
    expect(await findPathTenjin({ PATH: join(root, 'bin') }, 'linux')).toMatchObject({
      marked: true,
      handsOff: true,
    });
    expect(await findPathTenjin({ PATH: '' }, 'linux')).toBeNull();
  });
});

describe('readPluginLaunch', () => {
  let root: string;
  let fake: FakeClaude;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-launch-')));
    fake = await fakeClaude(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function marketplaceAt(path: string, files: Record<string, string>): Promise<void> {
    for (const [file, body] of Object.entries(files)) {
      await mkdir(dirname(join(path, file)), { recursive: true });
      await writeFile(join(path, file), body);
    }
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'directory', path }])}\n`,
    );
  }
  const read = () =>
    readPluginLaunch(
      { path: fake.bin, source: 'path' },
      { env: fake.env, home: root, cwd: root, scope: 'user' },
    );

  it("expands the package render's entry from the marketplace Claude Code lists", async () => {
    const pkgDist = join(root, 'pkg', 'dist');
    await marketplaceAt(join(pkgDist, 'hosts', 'claude'), renderHostFiles(pkg.version));
    expect(await read()).toEqual({
      path: join(pkgDist, 'hosts', 'claude'),
      source: 'marketplace',
      command: 'node',
      entry: join(pkgDist, 'index.js'),
    });
  });

  it('names the folder Claude Code loads with no router when its files are gone', async () => {
    const gone = join(root, 'runtime', 'claude');
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'directory', path: gone }])}\n`,
    );
    expect(await read()).toEqual({
      path: gone,
      source: 'marketplace',
      command: null,
      entry: null,
      missing: true,
    });
  });

  it('does not call a .mcp.json that is there but unreadable missing', async () => {
    const path = join(root, 'pkg', 'dist', 'hosts', 'claude');
    await marketplaceAt(path, { 'tenjin/.mcp.json': '{not json' });
    expect(await read()).toEqual({ path, source: 'marketplace', command: null, entry: null });
  });

  it("reads the runtime render's absolute Node and entry", async () => {
    const launch = { node: '/h/.tenjin/runtime/node/24.14.0/bin/node', entry: '/h/e/index.js' };
    await marketplaceAt(join(root, 'runtime', 'claude'), renderHostFiles(pkg.version, { launch }));
    expect(await read()).toMatchObject({ command: launch.node, entry: launch.entry });
  });
});
