import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { pinnedFetch } from './pinned-fetch';

/** A reply as the pinned transport hands it back. */
function reply(status: number, headers: Record<string, string | string[]>, body: string) {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: status,
    headers,
  }) as unknown as IncomingMessage;
}

const publicName = async () => [{ address: '93.184.216.34', family: 4 }];
const privateName = async () => [{ address: '10.0.0.5', family: 4 }];

// Failure caught by review: the seller's requests (the call, its refund and a withdrawal probe)
// went out on plain `fetch`, which resolves the name again on its own, so a catalog URL that named a
// private address, or a host that answered publicly to a check and privately a moment later, got
// the worker's prompt and history. The request now goes to the address that was checked.
it('refuses a name that resolves to a private address, and connects nowhere', async () => {
  const transport = vi.fn();
  const pinned = pinnedFetch({ destination: { resolveHostname: privateName }, transport });
  await expect(
    pinned('https://seller.example/chat', { method: 'POST', body: '{"secret":"prompt"}' }),
  ).rejects.toThrow(/private|network address/i);
  expect(transport).not.toHaveBeenCalled();
});

it('refuses a literal private address and a plain http URL without resolving or connecting', async () => {
  const transport = vi.fn();
  const resolveHostname = vi.fn(publicName);
  const pinned = pinnedFetch({ destination: { resolveHostname }, transport });
  await expect(pinned('https://192.168.1.10/chat', { method: 'POST' })).rejects.toThrow();
  await expect(pinned('http://seller.example/chat', { method: 'POST' })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it('connects to the address it checked, sends the request as given, and returns the reply as a Response', async () => {
  const seen: { target: unknown; request: unknown }[] = [];
  const transport = vi.fn(async (target: unknown, request: unknown) => {
    seen.push({ target, request });
    return reply(
      402,
      {
        'content-type': 'application/json',
        'payment-required': 'abc',
        'set-cookie': ['a=1', 'b=2'],
      },
      '{"error":"pay"}',
    );
  });
  const pinned = pinnedFetch({
    destination: { resolveHostname: publicName },
    transport: transport as never,
  });
  // A Request as the payment wrapper passes it, with a body and a header.
  const response = await pinned(
    new Request('https://seller.example/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': 'sig' },
      body: '{"hello":1}',
    }),
  );
  expect(seen[0]!.target).toMatchObject({ address: '93.184.216.34', family: 4 });
  expect((seen[0]!.target as { url: URL }).url.href).toBe('https://seller.example/chat');
  expect(seen[0]!.request).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'payment-signature': 'sig' },
  });
  expect(Buffer.from((seen[0]!.request as { body: Uint8Array }).body).toString()).toBe(
    '{"hello":1}',
  );
  expect(response.status).toBe(402);
  expect(response.headers.get('payment-required')).toBe('abc');
  expect(await response.text()).toBe('{"error":"pay"}');
});

it('follows no redirect and ends a reply that is too long', async () => {
  const redirect = pinnedFetch({
    destination: { resolveHostname: publicName },
    transport: (async () => reply(302, { location: 'https://10.0.0.5/x' }, '')) as never,
  });
  const res = await redirect('https://seller.example/chat', { method: 'POST' });
  expect(res.status).toBe(302);
  const long = pinnedFetch({
    destination: { resolveHostname: publicName },
    transport: (async () => reply(200, {}, 'x'.repeat(100))) as never,
    maxBytes: 50,
  });
  await expect(long('https://seller.example/chat', { method: 'GET' })).rejects.toThrow(/too long/);
});
