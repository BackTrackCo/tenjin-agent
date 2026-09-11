/** Each hour the log covers with its entry count, in the order the hours first appear. */
export function hourly(log) {
  const counts = {};
  for (const entry of log) {
    counts[entry.hour] = (counts[entry.hour] ?? 0) + 1;
  }
  return Object.entries(counts).map(([hour, count]) => ({ hour, count }));
}
