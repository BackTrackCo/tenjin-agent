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
