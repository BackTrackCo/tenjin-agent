import { describe, expect, it } from 'vitest';
import { assertPublicDestination, assertPublicHttpsUrl, isPublicAddress } from './destination';
import { CliError } from './errors';

describe('lexical destination checks', () => {
  it.each([
    'http://seller.example/api',
    'https://user:pass@seller.example/api',
    'https://seller.example/api#frag',
    'https://seller.example:8443/api',
    'https://localhost/api',
    'https://api.localhost/api',
    'https://box.internal/api',
    'https://printer.lan/api',
    'https://127.0.0.1/api',
    'https://10.1.2.3/api',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.0.1/api',
    'https://[::1]/api',
    'https://[fd00::1]/api',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertPublicHttpsUrl(url)).toThrow(CliError);
  });

  it('accepts an ordinary public HTTPS endpoint, port 443 included', () => {
    expect(assertPublicHttpsUrl('https://seller.example/api?q=1').host).toBe('seller.example');
    expect(assertPublicHttpsUrl('https://seller.example:443/api').port).toBe('');
    expect(assertPublicHttpsUrl('https://93.184.216.34/api').hostname).toBe('93.184.216.34');
  });

  it('classifies literal addresses the same way every caller needs', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:2800:220:1::1')).toBe(true);
    expect(isPublicAddress('100.64.0.1')).toBe(false);
    expect(isPublicAddress('198.18.0.1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
    expect(isPublicAddress('not-an-address')).toBe(false);
  });
});

describe('DNS preflight', () => {
  it('refuses a public name that resolves onto this network', async () => {
    await expect(
      assertPublicDestination('https://rebind.example/api', {
        resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('private or unsupported network address');
  });

  it('refuses a name with one private answer among public ones', async () => {
    await expect(
      assertPublicDestination('https://mixed.example/api', {
        resolveHostname: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
      }),
    ).rejects.toThrow('private or unsupported network address');
  });

  it.each([
    ['no answer at all', async () => []],
    [
      'a resolver failure',
      async () => {
        throw new Error('ENOTFOUND');
      },
    ],
  ])('refuses on %s rather than proceeding', async (_label, resolveHostname) => {
    await expect(
      assertPublicDestination('https://absent.example/api', {
        resolveHostname: resolveHostname as () => Promise<{ address: string; family: number }[]>,
      }),
    ).rejects.toThrow(CliError);
  });

  it('passes a name that resolves publicly, and skips the lookup for a literal address', async () => {
    let looked = 0;
    const url = await assertPublicDestination('https://seller.example/api', {
      resolveHostname: async () => {
        looked++;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    expect(url.host).toBe('seller.example');
    await assertPublicDestination('https://93.184.216.34/api', {
      resolveHostname: async () => {
        looked++;
        return [];
      },
    });
    expect(looked).toBe(1);
  });
});
