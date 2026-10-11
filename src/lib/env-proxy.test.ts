import { describe, expect, it, vi } from 'vitest';
import { envProxySupported, proxyVariable, useEnvProxy } from './env-proxy';

describe('useEnvProxy', () => {
  it('sets the global proxy when a proxy variable is set', () => {
    const setGlobal = vi.fn(() => () => undefined);
    const env = { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost' };
    expect(useEnvProxy(env, setGlobal)).toBe('set');
    expect(setGlobal).toHaveBeenCalledWith(env);
  });

  it.each([{}, { HTTPS_PROXY: '' }, { NO_PROXY: 'localhost' }])(
    'leaves the transport alone when no proxy variable is set (%j)',
    (env) => {
      const setGlobal = vi.fn(() => () => undefined);
      expect(useEnvProxy(env, setGlobal)).toBe('none');
      expect(setGlobal).not.toHaveBeenCalled();
    },
  );

  it('reads the lower-case and http forms too', () => {
    expect(proxyVariable({ http_proxy: 'http://proxy:3128' })).toBe('http_proxy');
    expect(proxyVariable({ https_proxy: 'http://proxy:3128' })).toBe('https_proxy');
  });

  it('reports a Node without setGlobalProxyFromEnv instead of calling it', () => {
    expect(useEnvProxy({ HTTPS_PROXY: 'http://proxy:3128' }, null)).toBe('unsupported');
    expect(envProxySupported(null)).toBe(false);
  });

  it('never throws on a proxy URL Node cannot parse', () => {
    const setGlobal = vi.fn(() => {
      throw new TypeError('Invalid proxy URL');
    });
    expect(useEnvProxy({ HTTPS_PROXY: 'not a url' }, setGlobal)).toBe('invalid');
  });

  it('finds the real function on this runtime', () => {
    expect(envProxySupported()).toBe(true);
  });
});
