import * as http from 'node:http';

/** Named, never quoted: a proxy URL can carry its own credentials. */
export const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

type SetGlobalProxy = (env: NodeJS.ProcessEnv) => () => void;

/** Node 24.14 added it. `engines` admits 22.0, where it is absent. */
const nodeSetGlobalProxy = (http as { setGlobalProxyFromEnv?: SetGlobalProxy })
  .setGlobalProxyFromEnv;

/** The first proxy variable this environment sets, or undefined. */
export function proxyVariable(env: NodeJS.ProcessEnv): string | undefined {
  return PROXY_VARIABLES.find((name) => (env[name] ?? '') !== '');
}

/** Can this Node route `fetch` through the proxy the environment names? */
export function envProxySupported(setGlobal: unknown = nodeSetGlobalProxy): boolean {
  return typeof setGlobal === 'function';
}

export type EnvProxyResult = 'none' | 'set' | 'unsupported' | 'invalid';

/**
 * Send `fetch` and `https.request` through the proxy the environment names.
 * Node's `fetch` ignores HTTPS_PROXY, HTTP_PROXY and NO_PROXY unless
 * NODE_USE_ENV_PROXY=1, so on a network where the proxy is the only way out the
 * harness reaches the internet and Tenjin does not. Called once by the bin
 * entry, so the CLI, the hooks and `tenjin mcp` all get it. Never throws: a
 * proxy URL Node cannot parse leaves the transport as it was.
 */
export function useEnvProxy(
  env: NodeJS.ProcessEnv,
  setGlobal: SetGlobalProxy | null = nodeSetGlobalProxy ?? null,
): EnvProxyResult {
  if (proxyVariable(env) === undefined) return 'none';
  if (typeof setGlobal !== 'function') return 'unsupported';
  try {
    setGlobal(env);
    return 'set';
  } catch {
    return 'invalid';
  }
}

/**
 * Why this Node's requests go past the proxy the environment names, or null
 * when none is named or this Node can use it. On a network whose only way out
 * is that proxy, a download then fails however often it is retried while the
 * same Node runs it, so a failure is said as this, never as a bare retry.
 */
export function proxySkipped(
  env: NodeJS.ProcessEnv,
  supported: boolean = envProxySupported(),
): string | null {
  const name = proxyVariable(env);
  if (name === undefined || supported) return null;
  return `this shell sets ${name}, which Node ${process.versions.node} cannot send downloads through`;
}

/** The step that works once a download skipped the proxy: one run on a Node that uses it. */
export function proxyNodeStep(command: string): string {
  return `run \`${command}\` once with Node 24.14 or newer, which uses the proxy; Tenjin's own Node does from then on`;
}
