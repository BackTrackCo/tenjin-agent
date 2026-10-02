import { once } from 'node:events';
import { createServer, request as plainRequest } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { httpRequest } from './http';
import { envProxyInUse, lookupFetch } from './public-fetch';

describe('the paid leg transport', () => {
  /** What `httpRequest` reads from a fetch, through a local server reachable
   *  only by the name the transport's lookup answers. `node:http` stands in for
   *  `node:https`, which takes the same options. */
  it('sends the request and hands back the response, connecting only through its lookup', async () => {
    const hits: { method?: string; url?: string; host?: string; length?: string; body: string }[] =
      [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        hits.push({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          length: req.headers['content-length'],
          body,
        });
        if (req.url === '/moved') {
          res.writeHead(302, { location: '/elsewhere' }).end();
          return;
        }
        res
          .writeHead(402, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'payment-required': 'challenge',
          })
          .end(gzipSync(JSON.stringify({ error: 'pay' })));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const looked: string[] = [];
    const lookup = ((
      host: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      looked.push(host);
      if (options.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    }) as unknown as LookupFunction;
    const fetchImpl = lookupFetch(lookup, plainRequest as never);
    try {
      const probe = await httpRequest(`http://seller.test:${port}/api?q=1`, {
        method: 'POST',
        timeoutMs: 5_000,
        rawBody: '{"q":"é"}',
        headers: { 'content-type': 'application/json' },
        blockRedirects: true,
        fetchImpl,
      });
      expect(probe).toMatchObject({ ok: true, status: 402, json: { error: 'pay' } });
      expect(probe.ok && probe.header('payment-required')).toBe('challenge');
      const moved = await httpRequest(`http://seller.test:${port}/moved`, {
        timeoutMs: 5_000,
        blockRedirects: true,
        fetchImpl,
      });
      // A 3xx comes back as itself, for `httpRequest` to refuse, never followed.
      expect(moved).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 302 });
      expect(hits).toEqual([
        {
          method: 'POST',
          url: '/api?q=1',
          host: `seller.test:${port}`,
          length: '10',
          body: '{"q":"é"}',
        },
        { method: 'GET', url: '/moved', host: `seller.test:${port}`, body: '' },
      ]);
      expect(looked).toEqual(['seller.test', 'seller.test']);
    } finally {
      server.close();
    }
  });

  it('stands aside only for a proxy Node was told to use', () => {
    const proxy = 'http://proxy.test:3128';
    expect(envProxyInUse({ HTTPS_PROXY: proxy }, [])).toBe(false);
    expect(envProxyInUse({ NODE_USE_ENV_PROXY: '1' }, [])).toBe(false);
    expect(envProxyInUse({ NODE_USE_ENV_PROXY: '1', https_proxy: proxy }, [])).toBe(true);
    expect(envProxyInUse({ HTTP_PROXY: proxy }, ['--use-env-proxy'])).toBe(true);
    expect(envProxyInUse({ NODE_OPTIONS: '--use-env-proxy', HTTPS_PROXY: proxy }, [])).toBe(true);
  });
});
