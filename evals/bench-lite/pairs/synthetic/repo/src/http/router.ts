/** The route table. One entry per thing the API can be asked to do. */
export interface Route {
  name: string;
  method: string;
  pattern: string;
}

export const ROUTES: readonly Route[] = [
  { name: 'health.get', method: 'GET', pattern: '/healthz' },
  { name: 'accounts.create', method: 'POST', pattern: '/accounts' },
  { name: 'accounts.list', method: 'GET', pattern: '/accounts' },
  { name: 'accounts.get', method: 'GET', pattern: '/accounts/:accountId' },
  { name: 'settings.get', method: 'GET', pattern: '/accounts/:accountId/settings' },
  { name: 'settings.patch', method: 'PATCH', pattern: '/accounts/:accountId/settings' },
  { name: 'entries.list', method: 'GET', pattern: '/accounts/:accountId/entries' },
  { name: 'balance.get', method: 'GET', pattern: '/accounts/:accountId/balance' },
  { name: 'entries.create', method: 'POST', pattern: '/entries' },
  { name: 'entries.batch', method: 'POST', pattern: '/entries/batch' },
];

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchOne(route: Route, method: string, path: string): RouteMatch | undefined {
  if (route.method !== method.toUpperCase()) {
    return undefined;
  }
  const wanted = segmentsOf(route.pattern);
  const given = segmentsOf(path);
  if (wanted.length !== given.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i += 1) {
    const slot = wanted[i] ?? '';
    const value = given[i] ?? '';
    if (slot.startsWith(':')) {
      params[slot.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (slot !== value) {
      return undefined;
    }
  }
  return { route, params };
}

/** The route for this method and path, or `undefined` for a 404. */
export function matchRoute(method: string, path: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    const match = matchOne(route, method, path);
    if (match) {
      return match;
    }
  }
  return undefined;
}
