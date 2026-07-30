import { describe, it, expect } from 'vitest';
import { fetchRead } from './read-client';
import { buildPaymentRequired, makeReadServer, readBody, reply } from './read-test-utils';

const URL_ = 'https://tenjin.blog/api/read/iris/slug';
const opts = (fetchImpl: typeof fetch) => ({ timeoutMs: 5000, fetchImpl });

describe('fetchRead', () => {
  it('returns entitled with the parsed body on 200', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.entitled(readBody()) });
    const res = await fetchRead(URL_, opts(fetch));
    expect(res.kind).toBe('entitled');
    if (res.kind === 'entitled') expect(res.body.bodyMd).toBe('# The Answer\n\nfull body\n');
  });

  it('decodes the PAYMENT-REQUIRED header and preview on 402', async () => {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({ plain: () => reply.paymentRequired(pr) });
    const res = await fetchRead(URL_, opts(fetch));
    expect(res.kind).toBe('payment_required');
    if (res.kind === 'payment_required') {
      expect(res.paymentRequired.accepts[0]?.amount).toBe('100000');
      expect(res.paymentRequired.accepts[0]?.scheme).toBe('exact');
    }
  });

  it('reports already_purchased on 409 (owned-re-pay gate)', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.alreadyPurchased() });
    const res = await fetchRead(URL_, opts(fetch));
    expect(res.kind).toBe('already_purchased');
  });

  it('sends the SIWX and payment headers when provided', async () => {
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody()),
      payment: () => reply.entitled(readBody()),
    });
    await fetchRead(URL_, {
      ...opts(fetch),
      siwxHeader: 'siwx-value',
      paymentHeaders: { 'PAYMENT-SIGNATURE': 'pay-value' },
    });
    expect(calls[0]?.headers['sign-in-with-x']).toBe('siwx-value');
    expect(calls[0]?.headers['payment-signature']).toBe('pay-value');
  });

  it('sends the session-key headers when provided, alongside the usual ones', async () => {
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody()),
      session: () => reply.entitled(readBody()),
    });
    await fetchRead(URL_, {
      ...opts(fetch),
      sessionHeaders: {
        'Tenjin-Session-Delegation': 'DELEGATION',
        'Signature-Input': 'tenjin=("@method" "@target-uri");created=1',
        Signature: 'tenjin=:sig:',
      },
    });
    expect(calls[0]?.headers['tenjin-session-delegation']).toBe('DELEGATION');
    expect(calls[0]?.headers.signature).toBe('tenjin=:sig:');
    // The client's own headers survive the merge.
    expect(calls[0]?.headers.accept).toBe('application/json');
    expect(calls[0]?.headers['x-tenjin-client']).toBeDefined();
  });

  it('reports session_rejected with the server code on a 401 to a session-signed read', async () => {
    const { fetch } = makeReadServer({
      plain: () => reply.entitled(readBody()),
      session: () => reply.sessionRejected('session_expired'),
    });
    const res = await fetchRead(URL_, {
      ...opts(fetch),
      sessionHeaders: { 'Tenjin-Session-Delegation': 'DELEGATION' },
    });
    expect(res).toEqual({ kind: 'session_rejected', code: 'session_expired' });
  });

  it('still throws on a 401 that presented NO session key (no silent soft outcome)', async () => {
    // The soft outcome exists because the session caller has a defined answer for
    // it. An unsigned or SIWX 401 has none, so widening it would hand `buy` and
    // `inspect` a state they cannot act on.
    const { fetch } = makeReadServer({ plain: () => reply.sessionRejected() });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });

  it('maps a 404 to RESOURCE_NOT_FOUND', async () => {
    const { fetch } = makeReadServer({ plain: () => new Response('{}', { status: 404 }) });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('maps a 429 on the paid-read path to RATE_LIMITED with retryAfterSeconds (backoff, not outage)', async () => {
    const { fetch } = makeReadServer({
      plain: () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 30 },
    });
  });

  it('flags a 402 with no PAYMENT-REQUIRED header as a contract mismatch', async () => {
    const { fetch } = makeReadServer({ plain: () => new Response('{}', { status: 402 }) });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('a 200 missing required fields is CONTRACT_MISMATCH (never delivered)', async () => {
    const { fetch } = makeReadServer({
      plain: () =>
        new Response(JSON.stringify({ id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('a 200 with a non-JSON body is CONTRACT_MISMATCH (never delivered)', async () => {
    const { fetch } = makeReadServer({
      plain: () => new Response('<html>not json</html>', { status: 200 }),
    });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('a 200 whose id is a path-traversal string is CONTRACT_MISMATCH (trust boundary)', async () => {
    const { fetch } = makeReadServer({
      plain: () => reply.entitled(readBody({ id: '../../../../etc/passwd' })),
    });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('a 200 whose slug escapes the slug charset is CONTRACT_MISMATCH', async () => {
    const { fetch } = makeReadServer({
      plain: () => reply.entitled(readBody({ slug: '../../evil' })),
    });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  // A signed request that gets redirected is refused by the transport (see
  // http.test.ts). Here: that refusal must surface as a CONTRACT_MISMATCH, not as
  // the API_UNREACHABLE the generic failure branch would otherwise give it. The
  // distinction is practical, not cosmetic — API_UNREACHABLE invites a retry, and
  // retrying re-sends the same signature into the same redirect.
  it('maps a refused redirect on a signed read to CONTRACT_MISMATCH', async () => {
    let seen = 0;
    const fetchImpl: typeof fetch = async () => {
      seen += 1;
      return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    };
    await expect(
      fetchRead(URL_, { timeoutMs: 1000, fetchImpl, siwxHeader: 'siwx-value' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    expect(seen).toBe(1);
  });

  // The UNSIGNED first probe is pinned too, for a different reason than the
  // credential guard: its 200 is written to the library as an entitlement record
  // under the server-chosen id/slug, and findDeliveredByUrl matches saved
  // receipts on handle+slug alone — so a followed cross-origin redirect would
  // let another host's bytes short-circuit a later `tenjin buy` as owned.
  it('refuses a redirect on the unsigned probe as well (the response becomes a durable record)', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      inits.push(init);
      return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    };
    await expect(fetchRead(URL_, { timeoutMs: 1000, fetchImpl })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe('manual');
  });

  // The pin is a WHOLE-CLASS refusal, and these are the tests that say so. The
  // trailing-slash regression was fixed by canonicalizing the URL in
  // `resolveResourceRef`, NOT by teaching the transport that a same-origin hop is
  // benign — an exemption here would be a second origin check in the one place
  // that already cannot see enough to make one. If someone ever relaxes
  // `blockRedirects` to permit same-origin, these fail.
  it('refuses a SAME-ORIGIN redirect on the unsigned probe (the pin was not relaxed)', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      inits.push(init);
      return new Response('', {
        status: 308,
        headers: { location: 'https://tenjin.blog/api/read/iris/slug' },
      });
    };
    await expect(fetchRead(`${URL_}/`, { timeoutMs: 1000, fetchImpl })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
    // One attempt, unfollowed: the transport does not silently retry the target.
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('refuses a SAME-ORIGIN redirect while carrying a signed header', async () => {
    let seen = 0;
    const fetchImpl: typeof fetch = async () => {
      seen += 1;
      return new Response('', {
        status: 307,
        headers: { location: 'https://tenjin.blog/api/read/iris/slug' },
      });
    };
    await expect(
      fetchRead(`${URL_}/`, { timeoutMs: 1000, fetchImpl, siwxHeader: 'siwx-value' }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    expect(seen).toBe(1);
  });

  // The finding's second half: the old `fix` said "The read route must not
  // redirect. Check the configured base URL" — three claims, all wrong for a route
  // canonicalizing a path. An agent that follows it does two useless things and
  // still cannot read the piece.
  it('does not blame the route or the base URL for a redirect the caller can fix', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('', { status: 308, headers: { location: URL_ } });
    const caught = await fetchRead(`${URL_}/`, { timeoutMs: 1000, fetchImpl }).then(
      () => null,
      (err: unknown) => err as { fix?: string },
    );
    expect(caught).not.toBeNull();
    const fix = caught?.fix ?? '';
    expect(fix).not.toMatch(/must not redirect/);
    expect(fix).not.toMatch(/update tenjin-cli/);
    // It names the two actionable things: the spelling to ask for, and the origin
    // to check. Why retrying cannot help is rationale for a reader of the code, so
    // it lives in the comment at the throw site rather than in an agent-facing
    // `fix` — which is also what keeps this one near the repo's 152-char maximum
    // instead of the 452 it used to be.
    expect(fix).toMatch(/tenjin search/);
    expect(fix).toMatch(/tenjin inspect/);
    expect(fix).toMatch(/tenjin doctor/);
    expect(fix.length).toBeLessThanOrEqual(160);
    // The origin half points at `doctor`, never at the base-URL flag: `read` is
    // meant to be allowlistable and the skill forbids that flag on an allowlisted
    // verb, so coaching it here would contradict the skill. main carries a
    // repo-wide source scan for this; this assertion is the local echo of it, so a
    // rewrite of THIS string fails on the branch instead of waiting for the merge.
    expect(fix).not.toMatch(/--base-url/);
  });
});
