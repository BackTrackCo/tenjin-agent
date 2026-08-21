/**
 * The one place the production Tenjin origin is written down. Every shipped
 * default, fallback, identity string, and piece of operator copy that names the
 * live site derives from here; `production-origin.test.ts` keeps it that way.
 *
 * This is NOT the base URL a command talks to. Ordinary requests resolve
 * `baseUrl` through config/flag/env precedence (`CONFIG_DEFAULTS.baseUrl` merely
 * starts from this value); `fund` alone pins production with no override surface
 * at all (owner decision, 2026-08-12) because its mint signs with the wallet key.
 * `fund.test.ts` and `client-meta.test.ts` each hold their own written-out copy,
 * so flipping this line alone reds the suite instead of moving the money path.
 */
export const PRODUCTION_ORIGIN = 'https://tenjin.blog';

/**
 * The bare host, for prose and messages that name the site rather than link to
 * it. Derived, not written twice: a flip cannot leave the two disagreeing.
 */
export const PRODUCTION_HOST = new URL(PRODUCTION_ORIGIN).host;

/**
 * Every origin the ONE production deployment answers on, exactly as `URL.origin`
 * spells it. Membership says one thing: a request to any of these reaches the
 * same server, the same publishers, the same prices, and the same SIWX domain
 * acceptance, so a URL the deployment emits on one of them is the deployment
 * talking about itself. The server builds candidate URLs from its own global
 * `NEXT_PUBLIC_APP_URL`, not from the request host, so the moment tenjin#402
 * flips that global a CLI configured against the other origin sees every
 * candidate as off-origin (tenjin#738). This set is what keeps that from
 * refusing the response.
 *
 * Membership is NOT trust and NOT an allowlist of places the CLI may pay. It
 * only lets one member stand in for another when the CONFIGURED base is itself a
 * member: any origin outside the set is refused exactly as before, a scheme or
 * port that differs is a different origin and gets no aliasing, and a
 * self-hosted or preview `baseUrl` an operator configured is aliased to nothing
 * at all. Widening this set widens where a signed credential may be sent, so it
 * changes only when the deployment genuinely starts answering somewhere new.
 */
const KNOWN_DEPLOYMENT_ORIGINS: ReadonlySet<string> = new Set([
  PRODUCTION_ORIGIN,
  'https://tenjin.sh',
]);

/**
 * Do these two origins name the same deployment? True for an exact match, and
 * for two distinct members of `KNOWN_DEPLOYMENT_ORIGINS`. Both sides must be
 * members: a configured base outside the set never gains an alias, so pointing
 * the CLI at a self-hosted deployment keeps the strict comparison it has today.
 *
 * Takes `URL.origin` strings. Anything else (a full URL, a bare host) is not a
 * member and falls through to the exact compare, which is the safe direction.
 */
export function isSameDeployment(a: string, b: string): boolean {
  if (a === b) return true;
  return KNOWN_DEPLOYMENT_ORIGINS.has(a) && KNOWN_DEPLOYMENT_ORIGINS.has(b);
}

/** The set as a plain array, for the generated hook script that cannot import. */
export function knownDeploymentOrigins(): string[] {
  return [...KNOWN_DEPLOYMENT_ORIGINS];
}
