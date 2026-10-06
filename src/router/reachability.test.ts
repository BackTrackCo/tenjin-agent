import { describe, expect, it } from 'vitest';
import { probeRouter } from './reachability';

const PROD = 'https://tenjin.blog';

const answer = (status: number, headers: Record<string, string> = {}) =>
  (async () => new Response('{}', { status, headers })) as typeof fetch;

/** fetch's own wrapping of an error, two links deep, as Node 24 throws it. */
const thrown = (inner: Error) =>
  (async () => {
    throw new TypeError('fetch failed', {
      cause: new Error('Request was cancelled.', { cause: inner }),
    });
  }) as typeof fetch;

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

const probe = (
  fetchImpl: typeof fetch,
  baseUrl = PROD,
  env: NodeJS.ProcessEnv = {},
  proxySupported = true,
) => probeRouter(baseUrl, { timeoutMs: 1000, fetchImpl, env, proxySupported });

describe('probeRouter', () => {
  it('passes on the route refusing the empty body', async () => {
    const check = await probe(answer(400, { 'x-vercel-id': 'iad1::x' }));
    expect(check).toMatchObject({ status: 'ok', detail: `${PROD}/api/x402-router is live` });
  });

  it('fails, without throwing, on a base URL that is not a URL', async () => {
    const check = await probe(answer(400), 'tenjin.blog');
    expect(check).toMatchObject({
      status: 'fail',
      detail: 'the base URL "tenjin.blog" is not a URL',
    });
    expect(check.fix).toContain('TENJIN_BASE_URL');
  });

  it('blames a proxy that refuses CONNECT, and leaves the base URL alone', async () => {
    const tunnel = withCode('Proxy response (403) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED');
    const check = await probe(thrown(tunnel), PROD, { HTTPS_PROXY: 'http://u:secret@proxy:3128' });
    expect(check.detail).toBe(
      'a proxy refused the connection to tenjin.blog (403), so the router never answered',
    );
    expect(check.fix).toBe(
      "Allow tenjin.blog through your proxy, firewall or VPN (this shell sets HTTPS_PROXY), or run from a network that reaches it. Tenjin's own config is correct and needs no change.",
    );
    expect(check.fix).not.toContain('secret');
  });

  it('sends a 407 from the proxy to its credentials, not to an allow-list', async () => {
    const tunnel = withCode('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED');
    const check = await probe(thrown(tunnel), PROD, { https_proxy: 'http://proxy:3128' });
    expect(check.detail).toBe(
      'a proxy between this machine and tenjin.blog asked for its own credentials (407)',
    );
    expect(check.fix).toBe(
      "Put the proxy's credentials in https_proxy (`http://user:password@proxy:port`), then try again.",
    );
  });

  it('says so when this Node cannot use the proxy the shell sets', async () => {
    const check = await probe(
      thrown(withCode('connect ECONNREFUSED', 'ECONNREFUSED')),
      PROD,
      { HTTPS_PROXY: 'http://proxy:3128' },
      false,
    );
    expect(check.fix).toContain('This shell sets HTTPS_PROXY, but Node');
    expect(check.fix).toContain('Upgrade to Node 24.14 or newer');
    expect(check.fix).not.toContain('Allow tenjin.blog through your proxy');
  });

  it('blames the network for a 403 that no deployment sent', async () => {
    const check = await probe(answer(403));
    expect(check.detail).toContain('answered 403 without the headers a Tenjin deployment sends');
    expect(check.fix).not.toContain('config set baseUrl');
  });

  it('never prescribes a base URL on the sibling production origin', async () => {
    const check = await probe(answer(403), 'https://tenjin.sh');
    expect(check.fix).not.toContain('config set baseUrl');
  });

  it('on production, a 401 the deployment sent is a refusal, not a wrong base URL', async () => {
    const check = await probe(answer(401, { 'x-vercel-id': 'iad1::x' }));
    expect(check).toMatchObject({
      detail: `${PROD}/api/x402-router refused this machine (401)`,
      fix: 'Try again later.',
    });
  });

  it('on another base, a 401 the deployment sent is an access-protected URL', async () => {
    const check = await probe(
      answer(401, { 'x-vercel-id': 'iad1::x' }),
      'https://preview.example.test',
    );
    expect(check.detail).toBe(
      'https://preview.example.test/api/x402-router is not a Tenjin router (it asked for credentials)',
    );
    expect(check.fix).toBe(
      'Set the router URL with `tenjin config set baseUrl https://tenjin.blog`.',
    );
  });

  it.each([
    [
      withCode('getaddrinfo ENOTFOUND tenjin.blog', 'ENOTFOUND'),
      'tenjin.blog did not resolve (ENOTFOUND)',
    ],
    [
      withCode('connect ECONNREFUSED', 'ECONNREFUSED'),
      'could not connect to tenjin.blog (ECONNREFUSED)',
    ],
    [
      withCode('unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'),
      'the TLS connection to tenjin.blog failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)',
    ],
  ])('names the layer for %s', async (inner, detail) => {
    const check = await probe(thrown(inner));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(detail);
    expect(check.fix).not.toContain('config set baseUrl');
  });

  it.each([
    ['https://tenjn.blog', withCode('getaddrinfo ENOTFOUND tenjn.blog', 'ENOTFOUND')],
    ['http://localhost:3000', withCode('connect ECONNREFUSED 127.0.0.1:3000', 'ECONNREFUSED')],
  ])('off production, sends an unreachable %s to the base URL', async (baseUrl, inner) => {
    const check = await probe(thrown(inner), baseUrl);
    expect(check.fix).toBe(
      'Check that the configured base URL names the Tenjin router (`tenjin config get baseUrl`), then try again later.',
    );
  });

  it('points a TLS failure at the CA a TLS-inspecting proxy needs', async () => {
    const check = await probe(
      thrown(withCode('self-signed certificate in chain', 'SELF_SIGNED_CERT_IN_CHAIN')),
    );
    expect(check.fix).toContain('NODE_EXTRA_CA_CERTS');
  });
});
