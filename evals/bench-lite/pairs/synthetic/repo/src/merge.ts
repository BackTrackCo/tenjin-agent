/**
 * One-level object layering, used wherever this service has defaults and an
 * override on top of them: account settings, job options, request defaults.
 *
 * ```ts
 * mergeDefaults({ retries: 3, backoffMs: 500 }, { retries: 5 });
 * // { retries: 5, backoffMs: 500 }
 * ```
 */
export function mergeDefaults<T extends object>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override)) {
    const value = (override as Record<string, unknown>)[key];
    if (value === undefined) {
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

/** Layer several overrides left to right on top of `base`. */
export function mergeAll<T extends object>(base: T, ...overrides: Partial<T>[]): T {
  let out = base;
  for (const override of overrides) {
    out = mergeDefaults(out, override);
  }
  return out;
}

/** A shallow copy with the keys whose value is `null` removed. */
export function withoutNulls<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) {
      out[key] = entry;
    }
  }
  return out as Partial<T>;
}
