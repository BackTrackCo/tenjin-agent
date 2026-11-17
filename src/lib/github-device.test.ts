import { describe, it, expect } from 'vitest';
import { pollForToken, requestDeviceCode, type DeviceCode } from './github-device';

interface Sent {
  url: string;
  form: Record<string, string>;
  accept: string | null;
  redirect: RequestInit['redirect'];
}

/** github.com, answering each request from `answers` in turn; a thrown answer is a dead socket. */
function github(answers: (Record<string, unknown> | Error | { status: number; json: unknown })[]): {
  fetchImpl: typeof fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
      accept: new Headers(init?.headers).get('accept'),
      redirect: init?.redirect,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    const { status, json } =
      'status' in next && 'json' in next ? next : { status: 200, json: next };
    return new Response(JSON.stringify(json), {
      status: status as number,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

/** A clock that only moves when the poll sleeps. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

const CODE: DeviceCode = {
  deviceCode: 'dev-123',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresInS: 900,
  intervalS: 5,
};

describe('requestDeviceCode', () => {
  it('asks github.com for a code with the client id and an empty scope, following no redirect', async () => {
    const { fetchImpl, sent } = github([
      {
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 899,
        interval: 5,
      },
    ]);
    const res = await requestDeviceCode('Iv1.abc123', { fetchImpl });
    expect(res).toEqual({
      ok: true,
      code: { ...CODE, expiresInS: 899 },
    });
    expect(sent).toEqual([
      {
        url: 'https://github.com/login/device/code',
        form: { client_id: 'Iv1.abc123', scope: '' },
        accept: 'application/json',
        redirect: 'manual',
      },
    ]);
  });

  it.each([
    'https://github.com.evil.example/login/device',
    'http://github.com/login/device',
    'https://evil.example/login/device',
    'https://user:pass@github.com/login/device',
    'https://github.com:8443/login/device',
    'javascript:alert(1)',
  ])('refuses a verification page that is not https://github.com/…: %s', async (uri) => {
    const { fetchImpl } = github([
      {
        device_code: 'dev-123',
        user_code: 'ABCD-1234',
        verification_uri: uri,
        expires_in: 900,
        interval: 5,
      },
    ]);
    expect(await requestDeviceCode('Iv1.abc123', { fetchImpl })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it("says GitHub refused, by its error, and that a dead network is the network's", async () => {
    const refused = github([{ status: 400, json: { error: 'device_flow_disabled' } }]);
    expect(await requestDeviceCode('Iv1.abc123', { fetchImpl: refused.fetchImpl })).toEqual({
      ok: false,
      reason: 'refused',
      detail: 'device_flow_disabled',
    });
    const down = github([new TypeError('fetch failed')]);
    expect(await requestDeviceCode('Iv1.abc123', { fetchImpl: down.fetchImpl })).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('pollForToken', () => {
  it('waits the interval before each poll and returns the token once the person approves', async () => {
    const c = clock();
    const { fetchImpl, sent } = github([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'gho_secret', token_type: 'bearer', scope: '' },
    ]);
    const res = await pollForToken('Iv1.abc123', CODE, { fetchImpl, ...c });
    expect(res).toEqual({ ok: true, token: 'gho_secret' });
    expect(c.slept).toEqual([5000, 5000, 5000]);
    expect(sent.every((s) => s.url === 'https://github.com/login/oauth/access_token')).toBe(true);
    expect(sent[0]!.form).toEqual({
      client_id: 'Iv1.abc123',
      device_code: 'dev-123',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(sent.every((s) => s.redirect === 'manual')).toBe(true);
  });

  it('adds five seconds to the interval on each slow_down, and keeps it', async () => {
    const c = clock();
    const { fetchImpl } = github([
      { error: 'slow_down' },
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'gho_secret' },
    ]);
    expect(await pollForToken('Iv1.abc123', CODE, { fetchImpl, ...c })).toMatchObject({ ok: true });
    expect(c.slept).toEqual([5000, 10000, 10000, 15000]);
  });

  it('expired_token is expired', async () => {
    const c = clock();
    const { fetchImpl } = github([{ error: 'authorization_pending' }, { error: 'expired_token' }]);
    expect(await pollForToken('Iv1.abc123', CODE, { fetchImpl, ...c })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it("stops at the code's own expiry without asking GitHub again", async () => {
    const c = clock();
    const pending = Array.from({ length: 10 }, () => ({ error: 'authorization_pending' }));
    const { fetchImpl, sent } = github(pending);
    const res = await pollForToken('Iv1.abc123', { ...CODE, expiresInS: 12 }, { fetchImpl, ...c });
    expect(res).toEqual({ ok: false, reason: 'expired' });
    // Polls at 5 s and 10 s; at 15 s the code is past its 12 s.
    expect(sent).toHaveLength(2);
  });

  it('access_denied is denied: the person cancelled on GitHub', async () => {
    const c = clock();
    const { fetchImpl } = github([{ error: 'access_denied' }]);
    expect(await pollForToken('Iv1.abc123', CODE, { fetchImpl, ...c })).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('rides out a network blip, and gives up on a network that stays down', async () => {
    const blip = clock();
    const recovered = github([
      new TypeError('fetch failed'),
      { status: 502, json: {} },
      { access_token: 'gho_secret' },
    ]);
    expect(
      await pollForToken('Iv1.abc123', CODE, { fetchImpl: recovered.fetchImpl, ...blip }),
    ).toEqual({ ok: true, token: 'gho_secret' });

    const down = clock();
    const dead = github([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    expect(await pollForToken('Iv1.abc123', CODE, { fetchImpl: dead.fetchImpl, ...down })).toEqual({
      ok: false,
      reason: 'network',
    });
    // A GitHub that answers only 5xx is down too, not a code left to expire.
    const failing = github([
      { status: 503, json: {} },
      { status: 503, json: {} },
      { status: 503, json: {} },
    ]);
    expect(
      await pollForToken('Iv1.abc123', CODE, { fetchImpl: failing.fetchImpl, ...clock() }),
    ).toEqual({ ok: false, reason: 'network' });
  });

  it('any other OAuth error is a refusal that names it', async () => {
    const c = clock();
    const { fetchImpl } = github([{ status: 400, json: { error: 'incorrect_device_code' } }]);
    expect(await pollForToken('Iv1.abc123', CODE, { fetchImpl, ...c })).toEqual({
      ok: false,
      reason: 'refused',
      detail: 'incorrect_device_code',
    });
  });
});
