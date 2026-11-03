import { describe, expect, it, vi } from 'vitest';
import { envProxySupported, proxySkipped, proxyVariable, useEnvProxy } from './env-proxy';

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

  // Node 24.14 added it. CI also runs the 22 floor, where it is absent.
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  it.runIf(major > 24 || (major === 24 && minor >= 14))(
    'finds the real function on Node 24.14+',
    () => {
      expect(envProxySupported()).toBe(true);
    },
  );
});

describe('proxySkipped', () => {
  it('names the variable and this Node only when this Node cannot use the proxy', () => {
    expect(proxySkipped({ https_proxy: 'http://proxy:3128' }, false)).toBe(
      `this shell sets https_proxy, which Node ${process.versions.node} cannot send downloads through`,
    );
    expect(proxySkipped({ https_proxy: 'http://proxy:3128' }, true)).toBeNull();
    expect(proxySkipped({}, false)).toBeNull();
  });
});
