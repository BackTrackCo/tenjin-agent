const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const DEFAULT_MS = 60_000;

/** The length of a named window in milliseconds, defaulting to the schedules' own tick. */
export function windowMs(name) {
  try {
    const [, count, unit] = name.match(/^(\d+)([smh])$/);
    return Number(count) * UNIT_MS[unit];
  } catch {
    return DEFAULT_MS;
  }
}
