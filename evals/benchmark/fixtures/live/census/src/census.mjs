import { firstSighting } from './ids.mjs';

/** The distinct people a log names and the visits its lines record. */
export function visitors(log) {
  let people = 0;
  for (const line of log) {
    if (firstSighting(line.badge)) people += 1;
  }
  return { people, visits: log.length };
}
