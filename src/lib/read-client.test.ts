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

  it('maps a 404 to RESOURCE_NOT_FOUND', async () => {
    const { fetch } = makeReadServer({ plain: () => new Response('{}', { status: 404 }) });
    await expect(fetchRead(URL_, opts(fetch))).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
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
});
