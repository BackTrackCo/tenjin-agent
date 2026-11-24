import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveLine } from '../lib/live-line';
import {
  parseStatus,
  recallLink,
  rememberLink,
  STATUS_GRACE_MS,
  tokenExpiry,
  tokenOf,
  watchFunding,
} from './fund-watch';

/** A fund token the way the server signs one: base64url payload, a dot, a MAC. */
function token(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ address: '0xabc', exp })).toString('base64url');
  return `${payload}.c2lnbmF0dXJl`;
}

/** Answers GET /api/fund/status from a queue of [status code, body]; counts the calls. */
function statusServer(answers: [number, unknown][]): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://tenjin.sh/api/fund/status');
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer .+\..+$/);
    const [status, body] = answers[Math.min(calls, answers.length - 1)]!;
    calls++;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

/** A status line that records what it was told, in order. */
function recorder(): { live: LiveLine; said: string[] } {
  const said: string[] = [];
  return {
    said,
    live: {
      spin: (text) => {
        if (said.at(-1) !== `… ${text}`) said.push(`… ${text}`);
      },
      ok: (text, detail) => said.push(`✓ ${text}${detail !== undefined ? ` ${detail}` : ''}`),
      warn: (text) => said.push(`! ${text}`),
      line: (text) => said.push(text.trim()),
      stop: () => undefined,
    },
  };
}

describe('the fund status a link reports', () => {
  it('reads "none" with no updatedAt, as the server sends it before any report', () => {
    expect(parseStatus({ state: 'none' })).toEqual({ state: 'none' });
    expect(
      parseStatus({ state: 'paid', updatedAt: '2026-11-08T10:00:00Z', amountUsd: 5.2 }),
    ).toEqual({ state: 'paid', updatedAt: '2026-11-08T10:00:00Z', amountUsd: 5.2 });
    expect(parseStatus({ state: 'landed' })).toBeNull();
    expect(parseStatus({ url: 'https://tenjin.sh/fund' })).toBeNull();
  });

  it('keeps `via` only for a code, and a reason only as printable text', () => {
    expect(parseStatus({ state: 'paying', via: 'code' })).toEqual({ state: 'paying', via: 'code' });
    expect(parseStatus({ state: 'paying', via: 'card' })).toEqual({ state: 'paying' });
    expect(parseStatus({ state: 'failed', via: 'code', reason: 'This code has expired.' })).toEqual(
      { state: 'failed', via: 'code', reason: 'This code has expired.' },
    );
    // Printed at the terminal: an escape sequence or a direction override never is.
    for (const reason of ['\x1b[2J', 'a\u202eb', 'x'.repeat(121), '  ']) {
      expect(parseStatus({ state: 'failed', via: 'code', reason })).toEqual({
        state: 'failed',
        via: 'code',
      });
    }
  });

  it('takes the token from a Tenjin /fund link only', () => {
    const t = token(1);
    expect(tokenOf(`https://tenjin.sh/fund?amount=5#${t}`)).toBe(t);
    expect(tokenOf(`https://pay.coinbase.com/buy#${t}`)).toBeUndefined();
    expect(tokenOf('https://tenjin.sh/fund#no-dot')).toBeUndefined();
    expect(tokenExpiry(t)).toBe(1);
  });

  it('remembers the last link for its wallet until the status grace runs out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenjin-link-'));
    try {
      const link = {
        version: 1 as const,
        address: '0xabc',
        url: 'https://tenjin.sh/fund#a.b',
        token: 'a.b',
        issuedAt: 1_000,
        expiresAt: 601_000,
        startBalanceAtomic: '0',
      };
      await rememberLink(dir, link);
      expect(await recallLink(dir, '0xABC', 2_000)).toEqual(link);
      expect(await recallLink(dir, '0xdef', 2_000)).toBeNull();
      expect(await recallLink(dir, '0xabc', 601_000 + STATUS_GRACE_MS + 1)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('watching a link until the money lands', () => {
  let clock: number;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  beforeEach(() => {
    clock = 1_000_000;
  });

  it('says each step the page reports, then the rise in the balance', async () => {
    const { fetchImpl } = statusServer([
      [200, { state: 'none' }],
      [200, { state: 'opened', updatedAt: 'x' }],
      [200, { state: 'paying', updatedAt: 'x' }],
      [200, { state: 'paid', updatedAt: 'x', amountUsd: 5.2 }],
    ]);
    const balances = [210_000n, 210_000n, 210_000n, 5_210_000n];
    const { live, said } = recorder();
    const end = await watchFunding({
      startBalance: 210_000n,
      readBalance: async () => balances.shift() ?? 5_210_000n,
      token: token(clock + 600_000),
      expiresAt: clock + 600_000,
      deadline: clock + 600_000,
      view: 'checkout',
      live,
      fetchImpl,
      now,
      sleep,
    });
    expect(end).toMatchObject({ kind: 'arrived', added: 5_000_000n, status: { state: 'paid' } });
    expect(said).toEqual([
      '… Waiting for the page to open…',
      '✓ Fund page open',
      '… Waiting for a payment or a code…',
      '… Waiting for your payment…',
      '✓ Payment received $5.20 charged',
      '… Adding to your balance…',
      '✓ Added to your balance +$5.00',
    ]);
  });

  /** Watch a fund-page link whose status route answers `statuses` in turn. */
  async function watchCode(
    statuses: [number, unknown][],
    balance: (read: number) => bigint,
    expiresAt = clock + 600_000,
  ) {
    const { fetchImpl } = statusServer(statuses);
    const { live, said } = recorder();
    let reads = 0;
    const end = await watchFunding({
      startBalance: 0n,
      readBalance: async () => balance(++reads),
      token: token(expiresAt),
      expiresAt,
      deadline: expiresAt + STATUS_GRACE_MS,
      view: 'checkout',
      live,
      fetchImpl,
      now,
      sleep,
    });
    return { end, said };
  }

  it('says a code is being redeemed, waits past the link while it lands, and names it on arrival', async () => {
    const expiresAt = clock + 4_000;
    const { end, said } = await watchCode(
      [
        [200, { state: 'opened', updatedAt: 'a' }],
        [200, { state: 'paying', via: 'code', updatedAt: 'b' }],
      ],
      (read) => (read >= 5 ? 1_000_000n : 0n),
      expiresAt,
    );
    expect(end).toMatchObject({ kind: 'arrived', added: 1_000_000n });
    expect(clock).toBeGreaterThan(expiresAt);
    expect(said).toEqual([
      '✓ Fund page open',
      '… Waiting for a payment or a code…',
      '… Redeeming your code…',
      '✓ Code accepted +$1.00',
    ]);
  });

  it('says a refused code with the page reason, keeps waiting, and a card payment still lands', async () => {
    const { end, said } = await watchCode(
      [
        [200, { state: 'opened', updatedAt: 'a' }],
        [200, { state: 'paying', via: 'code', updatedAt: 'b' }],
        [200, { state: 'failed', via: 'code', reason: 'This code has expired.', updatedAt: 'c' }],
        [200, { state: 'failed', via: 'code', reason: 'This code has expired.', updatedAt: 'c' }],
        [200, { state: 'paying', updatedAt: 'd' }],
        [200, { state: 'paid', updatedAt: 'e', amountUsd: 5 }],
      ],
      (read) => (read >= 5 ? 5_000_000n : 0n),
    );
    expect(end).toMatchObject({ kind: 'arrived', added: 5_000_000n });
    expect(said).toEqual([
      '✓ Fund page open',
      '… Waiting for a payment or a code…',
      '… Redeeming your code…',
      "! That code didn't work. This code has expired.",
      '… Waiting for a payment or a code…',
      '… Waiting for your payment…',
      '✓ Payment received $5.00 charged',
      '… Adding to your balance…',
      '✓ Added to your balance +$5.00',
    ]);
  });

  it('says each refused code once, with no reason sent, and a later code is accepted', async () => {
    const { end, said } = await watchCode(
      [
        [200, { state: 'failed', via: 'code', updatedAt: 'a' }],
        [200, { state: 'failed', via: 'code', updatedAt: 'a' }],
        [200, { state: 'failed', via: 'code', updatedAt: 'b' }],
        [200, { state: 'paying', via: 'code', updatedAt: 'c' }],
      ],
      (read) => (read >= 4 ? 1_000_000n : 0n),
    );
    expect(end).toMatchObject({ kind: 'arrived' });
    expect(said).toEqual([
      '✓ Fund page open',
      "! That code didn't work. The fund page says why.",
      '… Waiting for a payment or a code…',
      "! That code didn't work. The fund page says why.",
      '… Waiting for a payment or a code…',
      '… Redeeming your code…',
      '✓ Code accepted +$1.00',
    ]);
  });

  it('never credits a refused code with money whose payment the status missed', async () => {
    const { said } = await watchCode(
      [
        [200, { state: 'paying', via: 'code', updatedAt: 'a' }],
        [200, { state: 'failed', via: 'code', updatedAt: 'b' }],
        [500, {}],
      ],
      (read) => (read >= 4 ? 5_000_000n : 0n),
    );
    expect(said.at(-1)).toBe('✓ Added to your balance +$5.00');
  });

  // A server before codes never sends `via`, and another value is not a code.
  it.each([
    ['no via', {}],
    ['an unknown via', { via: 'voucher' }],
  ])('treats a status with %s as a card payment', async (_label, via) => {
    const { end, said } = await watchCode(
      [
        [200, { state: 'failed', updatedAt: 'a', ...via }],
        [200, { state: 'paying', updatedAt: 'b', ...via }],
      ],
      (read) => (read >= 3 ? 5_000_000n : 0n),
    );
    expect(end).toMatchObject({ kind: 'arrived' });
    expect(said).toEqual([
      '✓ Fund page open',
      "! That payment didn't go through. Nothing was charged.",
      '… Waiting for a payment or a code…',
      '… Waiting for your payment…',
      '✓ Added to your balance +$5.00',
    ]);
  });

  it('stops asking for a status the server does not have (404) and watches the balance alone', async () => {
    const { fetchImpl, calls } = statusServer([[404, { error: { code: 'not_found' } }]]);
    let reads = 0;
    const end = await watchFunding({
      startBalance: 0n,
      readBalance: async () => (++reads >= 3 ? 1_000_000n : 0n),
      token: token(clock + 600_000),
      deadline: clock + 600_000,
      view: 'checkout',
      fetchImpl,
      now,
      sleep,
    });
    expect(end).toMatchObject({ kind: 'arrived', added: 1_000_000n });
    expect(calls()).toBe(1);
  });

  it('backs off after a 429 rather than asking again on the next round', async () => {
    const { fetchImpl, calls } = statusServer([
      [429, {}],
      [200, { state: 'opened', updatedAt: 'x' }],
    ]);
    await watchFunding({
      startBalance: 0n,
      readBalance: async () => 0n,
      token: token(clock + 600_000),
      deadline: clock + 5 * 2_000,
      view: 'checkout',
      fetchImpl,
      now,
      sleep,
    });
    // Rounds 0..5: asked at round 0 (429), skipped 1-3, asked again at 4 and 5.
    expect(calls()).toBe(3);
  });

  it('ends when the link expires with nothing paid, and keeps waiting while a payment lands', async () => {
    const expiresAt = clock + 4_000;
    const opened = statusServer([[200, { state: 'opened', updatedAt: 'x' }]]);
    expect(
      await watchFunding({
        startBalance: 0n,
        readBalance: async () => 0n,
        token: token(expiresAt),
        expiresAt,
        deadline: expiresAt + STATUS_GRACE_MS,
        view: 'checkout',
        fetchImpl: opened.fetchImpl,
        now,
        sleep,
      }),
    ).toMatchObject({ kind: 'expired', statusKnown: true });

    clock = 1_000_000;
    let reads = 0;
    const paying = statusServer([[200, { state: 'paying', updatedAt: 'x' }]]);
    const end = await watchFunding({
      startBalance: 0n,
      readBalance: async () => (++reads > 5 ? 5_000_000n : 0n),
      token: token(expiresAt),
      expiresAt,
      deadline: expiresAt + STATUS_GRACE_MS,
      view: 'checkout',
      fetchImpl: paying.fetchImpl,
      now,
      sleep,
    });
    // An expiry never interrupts a payment.
    expect(end).toMatchObject({ kind: 'arrived' });
    expect(clock).toBeGreaterThan(expiresAt);
  });

  // An earlier "opened" is no evidence about the minutes since: a payment can
  // start while the reads fail or back off, so the expiry may not say that
  // nothing was charged.
  it.each<[string, [number, unknown]]>([
    ['fail', [500, {}]],
    ['are backed off after a 429', [429, {}]],
  ])('claims no outcome at expiry when the recent status reads %s', async (_label, failing) => {
    const expiresAt = clock + 6_000;
    const { fetchImpl } = statusServer([[200, { state: 'opened', updatedAt: 'x' }], failing]);
    const end = await watchFunding({
      startBalance: 0n,
      readBalance: async () => 0n,
      token: token(expiresAt),
      expiresAt,
      deadline: expiresAt + STATUS_GRACE_MS,
      view: 'checkout',
      fetchImpl,
      now,
      sleep,
    });
    expect(end).toMatchObject({ kind: 'expired', statusKnown: false });
  });

  it('times out at the deadline without a status to say', async () => {
    const end = await watchFunding({
      startBalance: 0n,
      readBalance: async () => undefined,
      deadline: clock + 10_000,
      view: 'funds',
      now,
      sleep,
    });
    expect(end).toEqual({ kind: 'timed-out' });
  });
});
