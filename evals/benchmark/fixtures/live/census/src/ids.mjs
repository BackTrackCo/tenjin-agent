// A log names the same badge on many lines, so the ids already counted are
// kept here and a line naming one of them is not counted again.
const COUNTED = new Set();

/** True when this is the first line of the log to name the badge. */
export function firstSighting(badge) {
  const id = badge.toLowerCase();
  if (COUNTED.has(id)) return false;
  COUNTED.add(id);
  return true;
}
