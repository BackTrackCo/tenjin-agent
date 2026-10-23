import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CliError } from '../../lib/errors';
import { openRedirect } from './loopback';

/**
 * The redirect listener, on a real 127.0.0.1 socket the test opens and closes
 * itself: the one place a sign-in's code arrives, so it takes exactly one
 * request carrying this sign-in's state, and echoes nothing back.
 */

const STATE = 's'.repeat(43);

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

describe('the sign-in redirect', () => {
  it('takes the redirect with this state, and nothing else, then closes', async () => {
    const redirect = await openRedirect({ state: STATE, timeoutMs: 5_000 });
    expect(redirect.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const waiting = redirect.wait();
    const wrong = await get(`${redirect.redirectUrl}?code=stolen&state=other`);
    expect(wrong.status).toBe(400);
    const elsewhere = await get(redirect.redirectUrl.replace('/callback', '/other'));
    expect(elsewhere.status).toBe(404);
    const right = await get(`${redirect.redirectUrl}?code=the-code&state=${STATE}`);
    expect(right.status).toBe(200);
    // The page echoes nothing the browser sent.
    for (const page of [wrong.body, elsewhere.body, right.body]) {
      expect(page).not.toContain('the-code');
      expect(page).not.toContain('stolen');
      expect(page).not.toContain(STATE);
    }
    expect(await waiting).toEqual({ code: 'the-code' });
    await expect(fetch(redirect.redirectUrl)).rejects.toThrow();
  });

  it('keeps a redirect that came before the wait began', async () => {
    const redirect = await openRedirect({ state: STATE, timeoutMs: 5_000 });
    await get(`${redirect.redirectUrl}?code=early&state=${STATE}`);
    expect(await redirect.wait()).toEqual({ code: 'early' });
  });

  it('reports a declined sign-in by its error, and an odd one as invalid', async () => {
    const declined = await openRedirect({ state: STATE, timeoutMs: 5_000 });
    await get(`${declined.redirectUrl}?error=access_denied&state=${STATE}`);
    expect(await declined.wait()).toEqual({ error: 'access_denied' });
    const odd = await openRedirect({ state: STATE, timeoutMs: 5_000 });
    await get(`${odd.redirectUrl}?error=%3Cscript%3E&state=${STATE}`);
    expect(await odd.wait()).toEqual({ error: 'invalid_request' });
  });

  it('gives up after its time, and closes', async () => {
    const redirect = await openRedirect({ state: STATE, timeoutMs: 50 });
    const error = await redirect.wait().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      'The sign-in was not finished in time. Nothing was saved.',
    );
    await expect(fetch(redirect.redirectUrl)).rejects.toThrow();
  });

  it('takes the first free fixed port, and refuses when every one is taken', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const taken = (holder.address() as AddressInfo).port;
    try {
      const free = await openRedirect({ state: STATE, timeoutMs: 1_000, ports: [taken, 0] });
      expect(free.redirectUrl).not.toContain(`:${taken}/`);
      free.close();
      const error = await openRedirect({ state: STATE, timeoutMs: 1_000, ports: [taken] }).catch(
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toMatch(/^Another sign-in is already waiting/);
    } finally {
      holder.close();
    }
  });
});
