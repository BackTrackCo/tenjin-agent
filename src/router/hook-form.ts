import { isRecord } from '../lib/guards';

/** Every handler in a hooks file (`{ hooks: { <Event>: [{ hooks: [...] }] } }`). */
export function handlersIn(file: unknown): unknown[] {
  const events = isRecord(file) ? file.hooks : undefined;
  if (!isRecord(events)) return [];
  return Object.values(events).flatMap((groups) =>
    Array.isArray(groups)
      ? groups.flatMap((g) => (isRecord(g) && Array.isArray(g.hooks) ? g.hooks : []))
      : [],
  );
}
