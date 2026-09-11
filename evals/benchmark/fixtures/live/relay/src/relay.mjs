import { windowMs } from './spans.mjs';

/** A count of events over a named window, as events a second to one decimal place. */
export function throughput(events, window) {
  const perSecond = events / (windowMs(window) / 1000);
  return { perSecond: Math.round(perSecond * 10) / 10 };
}
