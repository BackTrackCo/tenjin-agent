import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { CliError } from './errors';

/**
 * Where this CLI is willing to send a paid request. Shared, so the router's
 * provider call and `tenjin pay` answer the question the same way.
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
 * the plan for this release left unported for the paid leg. The router's media
 * download, a job's poll and a connected account's requests to a host its
 * server named do connect that way: each pins its socket to the address
 * {@link resolvePublicDestination} validated (`router/paid.ts`'s
 * `pinnedHttp`). What this does remove
 * is the easy local target: `http://`, credentials, a custom port, a literal
 * private address, a `.localhost`/`.internal` name, and a public name whose
 * only answers are private. Documented in docs/safety-model.md as a bound.
 *
 * AN ACCOUNT'S REACH ({@link DestinationOptions.allow}) is wider, for the user's
 * own servers (`router/accounts/fetch.ts`): any port, and besides public
 * addresses either this machine's loopback, where `http` is taken too, or the
 * private network. Link-local addresses (cloud metadata among them) are never
 * reached, whatever the reach.
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

/**
 * Which addresses an account request may reach besides public ones: none,
 * this machine's loopback, or the private network, never both. A server on
 * this machine is not let name a host on the network, nor one on the network
 * a host on this machine.
 */
export type AddressClass = 'public' | 'loopback' | 'private';

const loopbackNet = new BlockList();
loopbackNet.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackNet.addAddress('::1', 'ipv6');

const privateNet = new BlockList();
for (const [base, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateNet.addSubnet(base, prefix, 'ipv4');
}
privateNet.addSubnet('fc00::', 7, 'ipv6');
/** Inside fc00::/7 and still never reached: AWS's IPv6 instance metadata. */
const metadataV6 = new BlockList();
metadataV6.addAddress('fd00:ec2::254', 'ipv6');

const familyOf = (address: string) => (isIP(address) === 6 ? 'ipv6' : 'ipv4');
const isLoopbackAddress = (address: string) =>
  isIP(address) !== 0 && loopbackNet.check(address, familyOf(address));
const isPrivateAddress = (address: string) =>
  isIP(address) !== 0 &&
  privateNet.check(address, familyOf(address)) &&
  !metadataV6.check(address, familyOf(address));

/** Is this literal address one a request with this reach may go to? */
function inReach(address: string, allow: AddressClass | undefined): boolean {
  if (isPublicAddress(address)) return true;
  if (allow === 'loopback') return isLoopbackAddress(address);
  if (allow === 'private') return isPrivateAddress(address);
  return false;
}

/** `localhost`, or a literal loopback address (`[::1]` with or without its
 *  brackets): a host on this machine by its name alone, no lookup. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || isLoopbackAddress(host);
}

/**
 * The reach a server the user typed gives the hosts its sign-in names
 * (`router/accounts/fetch.ts`): loopback for one on this machine, private for
 * a literal private address, and public for any other, a `.local` name
 * included.
 */
export function addressClassOf(hostname: string): AddressClass {
  if (isLoopbackHost(hostname)) return 'loopback';
  return isPrivateAddress(hostname.replace(/^\[|\]$/g, '')) ? 'private' : 'public';
}

const LOCAL_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home|lan)$/i;

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new CliError('USAGE', message, {
    fix: 'Paid requests go to public HTTPS endpoints only; nothing was signed.',
    ...(details !== undefined ? { details } : {}),
  });
}

/** The lexical half: the URL shape alone, no network. Returns the parsed URL.
 *  `allow` is an account request's reach ({@link DestinationOptions.allow}). */
export function assertPublicHttpsUrl(raw: string, allow?: AddressClass): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(`Invalid URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // ON THIS MACHINE, for a reach that takes it: `localhost` by name, and http.
  const local = allow === 'loopback' && isLoopbackHost(host);
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (allow === undefined && url.port !== '' && url.port !== '443') ||
    raw.length > 16_384
  ) {
    refuse('Only public HTTPS endpoints without credentials, fragments or custom ports are paid.');
  }
  if (!(local && host === 'localhost')) {
    if (!host.includes('.') && isIP(host) === 0) refuse('The endpoint host is not a public name.');
    if (LOCAL_SUFFIX.test(host)) refuse('Private or local destinations are not paid.');
  }
  if (isIP(host) !== 0 && !inReach(host, allow)) {
    refuse('Private or reserved IP destinations are not paid.');
  }
  return url;
}

export interface DestinationOptions {
  /** Resolver seam; production leaves it unset and uses `dns.lookup`. */
  resolveHostname?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** One deadline for the whole resolution, not per address. */
  timeoutMs?: number;
  /**
   * AN ACCOUNT REQUEST'S REACH (`router/accounts/fetch.ts`): any port, and
   * public addresses plus the class named (`loopback`, where `http` to a
   * loopback host is taken too, or `private`). Unset, a paid request's: public
   * HTTPS on 443 alone.
   */
  allow?: AddressClass;
}

/**
 * The full preflight: the lexical check, then DNS. A literal address answered
 * the DNS question already and skips the lookup.
 */
export async function assertPublicDestination(
  raw: string,
  options: DestinationOptions = {},
): Promise<URL> {
  return (await resolvePublicDestination(raw, options)).url;
}

/**
 * The same preflight, returning the ONE address it validated, for a transport
 * that connects to exactly that address instead of resolving the name again
 * (see the module comment). Every answer must be in reach, as above; the
 * first is the one to pin.
 */
export async function resolvePublicDestination(
  raw: string,
  options: DestinationOptions = {},
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = assertPublicHttpsUrl(raw, options.allow);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return { url, address: host, family: isIP(host) === 6 ? 6 : 4 };
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
  // Plain http goes to this machine alone, whatever else the reach takes.
  const fits = (address: string) =>
    url.protocol === 'http:' ? isLoopbackAddress(address) : inReach(address, options.allow);
  if (addresses.length === 0 || addresses.some((entry) => !fits(entry.address))) {
    refuse(`The endpoint host ${host} resolves to a private or unsupported network address.`);
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}
