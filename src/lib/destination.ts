import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { CliError } from './errors';

/**
 * Where this CLI is willing to send a paid request. Ported from the draft
 * auto-mode experiment (PR #369 `execution.ts`) into a shared path, so the
 * router's provider call and `tenjin pay` answer the question the same way.
 *
 * TWO CHECKS, BOTH NEEDED. The lexical one refuses a URL shape that cannot be a
 * public endpoint (a scheme, credentials, a fragment, a literal private
 * address). The DNS one refuses a public-looking NAME that resolves onto the
 * local network, which is the shape a hostile registry listing or a hostile
 * routing decision would take.
 *
 * WHAT IT IS NOT. A resolved address is checked, NOT PINNED. `fetch` resolves
 * the name again on its own, so a host that answers publicly here and privately
 * a moment later is not closed by this, and neither is a remote scraper
 * following its own redirects on its own server. Closing the first needs a
 * transport that connects to the address it validated (`node:https` with a
 * `lookup` override, as the draft experiment's `safeHttpsTransport` did), which
 * the plan for this release deliberately left unported. What this does remove
 * is the easy local target: `http://`, credentials, a custom port, a literal
 * private address, a `.localhost`/`.internal` name, and a public name whose
 * only answers are private. Documented in docs/safety-model.md as a bound.
 */

const blockedV4 = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(base, prefix, 'ipv4');
}

const blockedV6 = new BlockList();
for (const [base, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedV6.addSubnet(base, prefix, 'ipv6');
}

/** Is this literal address one a paid request may be sent to? IPv6 additionally
 *  has to sit in the globally routable 2000::/3 range. */
export function isPublicAddress(value: string): boolean {
  const kind = isIP(value);
  if (kind === 4) return !blockedV4.check(value, 'ipv4');
  return kind === 6 && /^[23]/i.test(value) && !blockedV6.check(value, 'ipv6');
}

const LOCAL_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home|lan)$/i;

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new CliError('USAGE', message, {
    fix: 'Paid requests go to public HTTPS endpoints only; nothing was signed.',
    ...(details !== undefined ? { details } : {}),
  });
}

/** The lexical half: the URL shape alone, no network. Returns the parsed URL. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(`Invalid URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443') ||
    raw.length > 16_384
  ) {
    refuse('Only public HTTPS endpoints without credentials, fragments or custom ports are paid.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && isIP(host) === 0) refuse('The endpoint host is not a public name.');
  if (LOCAL_SUFFIX.test(host)) refuse('Private or local destinations are not paid.');
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    refuse('Private or reserved IP destinations are not paid.');
  }
  return url;
}

export interface DestinationOptions {
  /** Resolver seam; production leaves it unset and uses `dns.lookup`. */
  resolveHostname?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** One deadline for the whole resolution, not per address. */
  timeoutMs?: number;
}

/**
 * The full preflight: the lexical check, then DNS. A literal address answered
 * the DNS question already and skips the lookup.
 */
export async function assertPublicDestination(
  raw: string,
  options: DestinationOptions = {},
): Promise<URL> {
  const url = assertPublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return url;
  const resolve = options.resolveHostname ?? ((name: string) => lookup(name, { all: true }));
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  let addresses: { address: string; family: number }[];
  try {
    addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('DNS lookup timed out.')), {
          once: true,
        });
      }),
    ]);
  } catch (err) {
    return refuse(`The endpoint host ${host} could not be resolved.`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    refuse(`The endpoint host ${host} resolves to a private or unsupported network address.`);
  }
  return url;
}
