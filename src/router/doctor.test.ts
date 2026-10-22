import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import { createLocalProvider } from '../lib/wallet/local';
import { REPAIR_CLAUSE, type UnlockReason } from '../lib/wallet-unlock';
import type { CommandContext } from '../context';
import { fakeClaude, listed, type FakeClaude } from './claude-test-utils';
import {
  doctorLines,
  pluginStart,
  routingFeeRow,
  runRouterDoctor,
  sessionRow,
  walletRow,
  type RouterDoctorDeps,
} from './doctor';
import { canPayRouting, canSign, type SignVerdict, type Verdict } from './eligibility';
import { checkEligibility, type Eligibility } from './eligibility-check';
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
        '$0.003 a call, paid from channel deposits of up to $0.25 that count against the spend limits',
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
      routing(READY, { balanceAtomic: 100_000n }),
      'the wallet holds less than the $0.25 routing deposit, so routing calls take the free path',
      'Fund it with `tenjin wallet fund 5`.',
    ],
    [
      'no_wallet',
      routing(canSign({ envKey: 'absent', walletFile: 'absent' })),
      'this machine has no wallet, so routing calls take the free path',
      'Run `tenjin wallet create`, then `tenjin wallet fund 5`.',
    ],
    [
      'limit_below_deposit',
      routing(READY, { depositRefusal: 'limit_below_deposit' }),
      'the per-call spend limit is below the $0.25 routing deposit, so routing calls take the free path',
      'Raise it with `tenjin config set maxAutoSpend 0.25`.',
    ],
    [
      'budget_reached',
      routing(READY, { feeRefusal: 'budget_reached' }),
      'the daily spend limit has no room left for the routing fee or its deposit, so routing calls take the free path',
      'Room comes back as the rolling day passes, or raise it with `tenjin config set sessionBudget <usd>`.',
    ],
    [
      'not_allowlisted',
      routing(READY, { feeRefusal: 'not_allowlisted' }),
      'allowlistCreators does not include the router, so routing calls take the free path',
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
      `${WALLET_REASONS[reason as keyof typeof WALLET_REASONS].reason}, so routing calls take the free path`,
    );
    expect(row.fix).toBe(WALLET_REASONS[reason as keyof typeof WALLET_REASONS].fix);
    expectPersonFix(row.fix);
  });
});

describe('walletRow', () => {
  it('fails, as required, with today’s words when there is no wallet and no key', () => {
    expect(
      walletRow(
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
    expect(walletRow(eligibility({ describeError: err, canSign: READY }))).toEqual({
      name: 'wallet',
      status: 'fail',
      required: true,
      detail: 'The wallet file is not valid JSON.',
      fix: 'Restore it from a backup.',
    });
  });

  it('fails an invalid TENJIN_WALLET_KEY as required', () => {
    const row = walletRow(
      eligibility({ canSign: canSign({ envKey: 'malformed', walletFile: 'absent' }) }),
    );
    expect(row).toMatchObject({ status: 'fail', required: true });
    expectPersonFix(row.fix);
  });

  it.each<[string, string]>([
    ['keychain', 'macOS keychain'],
    ['secret-service', 'Linux keyring'],
    ['dpapi', 'DPAPI file'],
    ['file', `passphrase file ~/.tenjin/passphrase.${ADDRESS.toLowerCase()}.plain`],
    ['key-env', 'TENJIN_WALLET_KEY in this shell'],
    ['passphrase-env', 'TENJIN_WALLET_PASSPHRASE in this shell'],
    ['legacy', 'legacy keychain entry'],
  ])('passes a wallet that unlocks from %s', (source, where) => {
    expect(
      walletRow(eligibility({ canSign: { status: 'ready', source: source as 'keychain' } })),
    ).toEqual({
      name: 'wallet',
      status: 'ok',
      required: true,
      detail: `${ADDRESS} unlocks without a prompt (${where})`,
    });
  });

  it('passes TENJIN_WALLET_KEY alone', () => {
    const row = walletRow(
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
      walletRow(
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
      const row = walletRow(eligibility({ canSign: blockedSign(reason) }));
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
    const row = walletRow(eligibility({ canSign: blockedSign('keychain_locked') }));
    expect(row).toMatchObject({
      status: 'warn',
      required: false,
      checked: false,
      fix: KEYCHAIN_LOCKED_FIX,
    });
    expect(row.detail).toMatch(new RegExp(`^could not check whether ${ADDRESS} unlocks: `));
  });

  it('says any other unknown could not be checked, with no fix', () => {
    const row = walletRow(eligibility({ canSign: blockedSign('unlock_timeout') }));
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
      detail: `the router Claude Code started (pid 4242) ${entry.reason}`,
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
        'the wallet holds less than the $0.25 routing deposit, so routing calls take the free path',
      fix: 'Fund it with `tenjin wallet fund 5`.',
    });
    expect((out as { humanLines: string[] }).humanLines.at(-1)).toBe(
      `${checks.length} checks, 1 to act on, 1 not checked.`,
    );
  });

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
    const { by, out } = await run({
      eligibility: async () => eligibility(),
      listProcesses: async () => ({
        routers: [{ pid: 777, startedAt: 5_000, kind: 'plugin', underClaude: true }],
        claude: [],
      }),
      readObservations: async () => [live, observation({ pid: 778, servedSession: false })],
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
