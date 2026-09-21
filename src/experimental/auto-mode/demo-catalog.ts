import research from './fixtures/cdp-demo-resources.json';
import quotes from './fixtures/cdp-cmc-resource.json';
import enrichment from './fixtures/cdp-gtm-resources.json';
import math from './fixtures/cdp-math-resources.json';

/** Explicit MVP selection. Translation provenance travels with the effective
 * records; this does not claim live semantic discovery or paid verification. */
export function demoCatalog() {
  const captures = [research, quotes, enrichment, math];
  return {
    source: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources',
    fetchedAt: captures
      .map((capture) => capture.fetchedAt)
      .sort()
      .at(-1)!,
    resources: [...research.resources, quotes.resource, ...enrichment.resources, ...math.resources],
    provenance: captures.map((capture) =>
      Object.fromEntries(
        Object.entries(capture).filter(
          ([key]) => !['resources', 'resource', 'companions'].includes(key),
        ),
      ),
    ),
  };
}
