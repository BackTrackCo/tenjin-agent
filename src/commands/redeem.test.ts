import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';

// The only chain touch is the balance read; mock it so the suite is offline.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  getUsdcBalance: vi.fn(),
}));
vi.mock('../lib/usdc-balance', async (importOriginal) =>
  (await import('../lib/usdc-test-utils')).bridgedUsdcBalance(
    await importOriginal<typeof import('../lib/usdc-balance')>(),
  ),
);

import { getUsdcBalance } from '../lib/usdc';
import { runRedeem, type RedeemOptions } from './redeem';
import { runBalance } from './balance';

const mockedBalance = vi.mocked(getUsdcBalance);
/** Written out, not read from PRODUCTION_ORIGIN: the redeem signs with the wallet key there. */
const ORIGIN = 'https://tenjin.sh';
const HASH = 'b'.repeat(64);
const TX = `0x${'c'.repeat(64)}`;
const TOKEN = 'gho_DoNotPrintThisToken123';
const PAGE = `${ORIGIN}/fund#eyJleHAiOjF9.c2ln`;

let tmp: string;
let stderr: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-redeem-'));
  stderr = [];
  mockedBalance.mockReset();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(o: { isTTY?: boolean; json?: boolean } = {}): CommandContext {
  return {
    flags: { json: o.json ?? true, timeout: 10_000 },
    dataDir: join(tmp, '.tenjin'),
    io: {
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      isTTY: o.isTTY ?? false,
    },
  };
}

function fakeProvider(): { provider: WalletProvider; address: Address } {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer: TenjinSigner = {
    address: account.address,
    signMessage: (a) => account.signMessage(a),
    signTypedData: (a) => account.signTypedData(a as never),
    signTransaction: (tx) => account.signTransaction(tx),
  };
  return {
    provider: {
      id: 'fake',
      describe: async () => ({
        address: account.address,
        provider: 'fake',
        credentialSource: 'remote',
        policyEnforcement: 'provider',
      }),
      getSigner: async () => signer,
      diagnostics: async () => ({ warnings: [] }),
    },
    address: account.address,
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Reply = [number, unknown];

/**
 * tenjin.sh and github.com, each route answering from its own queue (the last
 * answer repeats). Every request is recorded, so a test can say which hosts
 * were never asked.
 */
function servers(routes: {
  redeem?: Reply[];
  deviceCode?: Reply[];
  token?: Reply[];
  fundLink?: Reply[];
}): { fetchImpl: typeof fetch; sent: Sent[]; to: (path: string) => Sent[] } {
  const sent: Sent[] = [];
  const queues: Record<string, Reply[]> = {
    [`${ORIGIN}/api/promo/redeem`]: routes.redeem ?? [],
    'https://github.com/login/device/code': routes.deviceCode ?? [],
    'https://github.com/login/oauth/access_token': routes.token ?? [],
    [`${ORIGIN}/api/fund/link`]: routes.fundLink ?? [],
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const queue = queues[url];
    if (queue === undefined || queue.length === 0) return new Response('{}', { status: 404 });
    const [status, json] = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, sent, to: (path) => sent.filter((s) => s.url.endsWith(path)) };
}

/** A clock that moves only when the command sleeps. */
function clock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** runRedeem with this machine kept out of it: no harness variables, a desktop, no real clipboard or ID. */
function redeem(ctx: CommandContext, opts: Partial<RedeemOptions> & { code: string }) {
  return runRedeem(ctx, {
    env: {},
    platform: 'darwin',
    machineHash: async () => HASH,
    deviceName: async () => 'Test Mac',
    copyText: async () => true,
    openUrl: async () => true,
    ...clock(),
    ...opts,
  });
}

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('expected a CliError');
}

const credited = (address: string, extra: Record<string, unknown> = {}) => ({
  address,
  code: 'NCSTATE26',
  amountAtomic: '2000000',
  txHash: TX,
  confirmed: true,
  balanceAtomic: '2000000',
  ...extra,
});

const GITHUB_REQUIRED: Reply = [
  403,
  {
    error: {
      code: 'promo_github_required',
      message: 'Sign in with GitHub to redeem this code.',
      details: { clientId: 'Iv1.tenjinpromo' },
    },
  },
];
const DEVICE: Reply = [
  200,
  {
    device_code: 'dev-123',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  },
];

describe('runRedeem: a code that needs no GitHub', () => {
  it('redeems a table code with one signed POST for this wallet and returns the credit', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({ redeem: [[200, credited(address, { code: 'TABLE-42' })]] });
    const res = await redeem(makeCtx(), {
      provider,
      fetchImpl: net.fetchImpl,
      code: '  table-42 ',
    });

    expect(net.sent.map((s) => s.url)).toEqual([`${ORIGIN}/api/promo/redeem`]);
    expect(net.sent[0]!.body).toEqual({ address, code: 'table-42', machineHash: HASH });
    const proof = parseSIWxHeader(net.sent[0]!.headers['sign-in-with-x']!) as Record<
      string,
      unknown
    >;
    expect(proof.domain).toBe('tenjin.sh');
    expect(String(proof.address).toLowerCase()).toBe(address.toLowerCase());
    expect(res.data).toMatchObject({
      address,
      code: 'TABLE-42',
      added: { atomic: '2000000', usd: '2' },
      balance: { atomic: '2000000', usd: '2' },
      txHash: TX,
      confirmed: true,
    });
  });

  it('refuses a malformed code locally, before any request', async () => {
    const { provider } = fakeProvider();
    const net = servers({});
    const err = await catchCliError(
      redeem(makeCtx(), { provider, fetchImpl: net.fetchImpl, code: 'NC STATE 26' }),
    );
    expect(err.code).toBe('USAGE');
    expect(net.sent).toHaveLength(0);
  });
});

describe('runRedeem at a terminal: a code that needs GitHub', () => {
  it('runs the device flow, then asks again with the token, and prints the credit', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({
      redeem: [GITHUB_REQUIRED, [200, credited(address)]],
      deviceCode: [DEVICE],
      token: [
        [200, { error: 'authorization_pending' }],
        [200, { access_token: TOKEN, token_type: 'bearer', scope: '' }],
      ],
    });
    const openUrl = vi.fn(async () => true);
    const res = await redeem(makeCtx({ isTTY: true, json: false }), {
      provider,
      fetchImpl: net.fetchImpl,
      openUrl,
      code: 'NCSTATE26',
    });

    // The GitHub app is the one the server named.
    expect(net.to('/login/device/code')[0]!.body).toEqual({
      client_id: 'Iv1.tenjinpromo',
      scope: '',
    });
    const [first, retry] = net.to('/api/promo/redeem');
    expect(first!.body).not.toHaveProperty('githubToken');
    expect(retry!.body).toEqual({
      address,
      code: 'NCSTATE26',
      machineHash: HASH,
      githubToken: TOKEN,
    });
    // A SIWX nonce is single-use: the retry signs a fresh proof.
    expect(retry!.headers['sign-in-with-x']).not.toBe(first!.headers['sign-in-with-x']);
    expect(openUrl).toHaveBeenCalledWith('https://github.com/login/device');

    const out = stderr.join('');
    expect(out).toContain('Redeem NCSTATE26');
    expect(out).toContain('Tenjin sees only your public profile.');
    expect(out).toContain('Code      ABCD-1234  copied');
    expect(out).toContain('GitHub    opened in your browser: paste the code, then Authorize');
    expect(out).toContain('✓ GitHub confirmed');
    expect(out).toContain('✓ $2.00 added');
    // The token is sent once and never shown.
    expect(out).not.toContain(TOKEN);
    expect(JSON.stringify(res.data)).not.toContain(TOKEN);
    expect(res.humanLines).toEqual(['  Balance   $2.00']);
  });

  it('with no browser and no clipboard, says where to enter the code instead', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({
      redeem: [GITHUB_REQUIRED, [200, credited(address)]],
      deviceCode: [DEVICE],
      token: [[200, { access_token: TOKEN }]],
    });
    const openUrl = vi.fn(async () => true);
    await redeem(makeCtx({ isTTY: true, json: false }), {
      provider,
      fetchImpl: net.fetchImpl,
      openUrl,
      copyText: async () => false,
      env: { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' },
      code: 'NCSTATE26',
    });
    expect(openUrl).not.toHaveBeenCalled();
    const out = stderr.join('');
    expect(out).toContain('Code      ABCD-1234\n');
    expect(out).toContain('GitHub    open github.com/login/device and enter the code');
  });

  it('a cancelled sign-in redeems nothing: no second POST is made', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({
      redeem: [GITHUB_REQUIRED],
      deviceCode: [DEVICE],
      token: [[200, { error: 'access_denied' }]],
    });
    const err = await catchCliError(
      redeem(makeCtx({ isTTY: true, json: false }), {
        provider,
        fetchImpl: net.fetchImpl,
        code: 'NCSTATE26',
      }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('Nothing was redeemed');
    expect(net.to('/api/promo/redeem')).toHaveLength(1);
  });
});

describe('runRedeem off a terminal: a code that needs GitHub', () => {
  it.each([
    ['under an agent harness', { isTTY: false, json: false }, { CLAUDECODE: '1' }],
    ['with --json at a terminal', { isTTY: true, json: true }, {}],
  ])(
    'opens the fund page with the code instead of a device flow, %s',
    async (_label, ctxOpts, env) => {
      const { provider, address } = fakeProvider();
      mockedBalance.mockResolvedValue(0n);
      const net = servers({ redeem: [GITHUB_REQUIRED], fundLink: [[200, { url: PAGE }]] });
      const openUrl = vi.fn(async () => true);
      const res = await redeem(makeCtx(ctxOpts), {
        provider,
        fetchImpl: net.fetchImpl,
        openUrl,
        env,
        code: 'NCSTATE26',
      });

      expect(net.sent.filter((s) => s.url.startsWith('https://github.com'))).toHaveLength(0);
      expect(net.to('/api/fund/link')).toHaveLength(1);
      expect(net.to('/api/fund/link')[0]!.body).toMatchObject({
        address,
        code: 'NCSTATE26',
        machineHash: HASH,
      });
      expect(res.data).toMatchObject({
        checkoutUrl: PAGE,
        code: 'NCSTATE26',
        redeem: 'browser',
        pollStatus: 'skipped',
      });
      const nextStep = (res.data as { nextStep: string }).nextStep;
      expect(nextStep).toContain('GitHub sign-in');
      expect(nextStep).toContain('`tenjin balance --wait` in the background');
      expect(nextStep).toContain('Never ask the person to type "done"');
    },
  );
});

describe('runRedeem: refusals', () => {
  it.each([
    [404, 'promo_code_not_found', 'REFUSED'],
    [409, 'promo_code_not_started', 'REFUSED'],
    [410, 'promo_code_expired', 'REFUSED'],
    [410, 'promo_code_used', 'REFUSED'],
    [410, 'promo_credits_ran_out', 'REFUSED'],
    [403, 'promo_github_too_new', 'REFUSED'],
    [409, 'promo_already_redeemed', 'REFUSED'],
    [409, 'promo_already_redeemed_machine', 'REFUSED'],
    [409, 'promo_already_redeemed_wallet', 'REFUSED'],
    [401, 'promo_github_invalid', 'REFUSED'],
    [502, 'promo_github_unreachable', 'API_UNREACHABLE'],
    [503, 'promo_unavailable', 'API_UNREACHABLE'],
    // A code a later server adds still says its own thing.
    [409, 'promo_some_future_rule', 'REFUSED'],
  ])('%i %s prints the server message as sent', async (status, code, cliCode) => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const message = `Server wording for ${code}. Grab a code at the Tenjin table.`;
    const net = servers({ redeem: [[status, { error: { code, message } }]] });
    const err = await catchCliError(
      redeem(makeCtx(), { provider, fetchImpl: net.fetchImpl, code: 'NCSTATE26' }),
    );
    expect(err.message).toBe(message);
    expect(err.code).toBe(cliCode);
    expect(err.details).toEqual({ reason: code });
  });

  it('a 401 with no promo code is the clock, as for `tenjin fund`', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({ redeem: [[401, { error: { code: 'unauthorized' } }]] });
    const err = await catchCliError(
      redeem(makeCtx(), { provider, fetchImpl: net.fetchImpl, code: 'NCSTATE26' }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('clock');
  });

  // The code is spent: a rerun only hears "already redeemed", so it never says retry.
  it('an unconfirmed transfer points at the balance, not a retry', async () => {
    const { provider } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({
      redeem: [[503, { error: { code: 'promo_unconfirmed', message: 'Not confirmed yet.' } }]],
    });
    const err = await catchCliError(
      redeem(makeCtx(), { provider, fetchImpl: net.fetchImpl, code: 'NCSTATE26' }),
    );
    expect(err.message).toBe('Not confirmed yet.');
    expect(err.fix).toContain('tenjin balance');
    expect(err.fix).not.toMatch(/retry/i);
  });
});

describe('runRedeem: a transfer the server has not seen land', () => {
  it('watches the balance until it rises by the credit', async () => {
    const { provider, address } = fakeProvider();
    // The baseline, two reads before it lands, then the credit.
    mockedBalance
      .mockResolvedValueOnce(500_000n)
      .mockResolvedValueOnce(500_000n)
      .mockResolvedValueOnce(500_000n)
      .mockResolvedValue(2_500_000n);
    const net = servers({
      redeem: [[200, credited(address, { confirmed: false, balanceAtomic: undefined })]],
    });
    const res = await redeem(makeCtx({ isTTY: true, json: false }), {
      provider,
      fetchImpl: net.fetchImpl,
      code: 'NCSTATE26',
    });
    expect(res.data).toMatchObject({
      confirmed: true,
      balance: { atomic: '2500000', usd: '2.5' },
    });
    expect(stderr.join('')).toContain('✓ $2.00 added');
    expect(res.humanLines).toEqual(['  Balance   $2.50']);
  });

  it('past the watch, says it is on its way, and `tenjin balance --wait` still counts it', async () => {
    const { provider, address } = fakeProvider();
    mockedBalance.mockResolvedValue(0n);
    const net = servers({
      redeem: [[200, credited(address, { confirmed: false, balanceAtomic: undefined })]],
    });
    const ctx = makeCtx();
    const c = clock();
    const res = await redeem(ctx, {
      provider,
      fetchImpl: net.fetchImpl,
      code: 'NCSTATE26',
      watchMs: 9_000,
      ...c,
    });
    expect(res.data).toMatchObject({ confirmed: false, added: { usd: '2' } });
    expect(res.data).not.toHaveProperty('balance');
    expect((res.data as { nextStep: string }).nextStep).toContain(
      '`tenjin balance --wait` in the background',
    );

    // It lands before the agent's wait starts: the wait reports it anyway.
    mockedBalance.mockResolvedValue(2_000_000n);
    const waited = await runBalance(ctx, {
      provider,
      wait: true,
      waitMs: 1_000,
      ...c,
      fetchImpl: net.fetchImpl,
    });
    expect(waited.data).toMatchObject({ arrived: true, added: { atomic: '2000000' } });
  });
});
