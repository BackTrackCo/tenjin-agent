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
 * Every origin the ONE production deployment answers on, as `URL.origin` spells
 * it. Membership means a request to any of them reaches the same server,
 * publishers, prices, and SIWX domain acceptance. It exists because the server
 * builds candidate URLs from its own `NEXT_PUBLIC_APP_URL`, not the request
 * host, so the moment tenjin#402 flips that global a CLI on the other origin
 * sees every candidate as off-origin (tenjin#738).
 *
 * Membership is NOT trust and NOT an allowlist of places the CLI may pay, but it
 * IS the widest set a wallet-signed credential can reach, so widening it is a
 * security change. Removal runbook: docs/safety-model.md.
 */
const KNOWN_DEPLOYMENT_ORIGINS: ReadonlySet<string> = new Set([
  PRODUCTION_ORIGIN,
  'https://tenjin.sh',
]);

/**
 * Do these two origins name the same deployment? Exact match, or two members of
 * the set. BOTH sides must be members, so a self-hosted or preview base gains no
 * alias and keeps today's strict compare, and a differing scheme or port is a
 * different origin that aliases to nothing. Takes `URL.origin` strings; anything
 * else is not a member and falls through to the exact compare.
 */
export function isSameDeployment(a: string, b: string): boolean {
  if (a === b) return true;
  return KNOWN_DEPLOYMENT_ORIGINS.has(a) && KNOWN_DEPLOYMENT_ORIGINS.has(b);
}

/** The set as a plain array, for the generated hook script that cannot import. */
export function knownDeploymentOrigins(): string[] {
  return [...KNOWN_DEPLOYMENT_ORIGINS];
}
