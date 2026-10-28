/**
 * Base USDC's address and one `balanceOf` over plain JSON-RPC, for the
 * commands that read a balance on request (`tenjin status`, `tenjin doctor`).
 * No viem on purpose: one `eth_call` needs nothing viem adds. The hooks never
 * read a balance; the facilitator's check on a deposit is theirs.
 * `usdc.ts` keeps the viem client for the send path and re-exports the
 * address from here.
 */

// Values mirror the app's lib/chain.ts Base mainnet entry (chain 8453).
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** `balanceOf(address)`: the first four bytes of its keccak-256. */
const BALANCE_OF_SELECTOR = '0x70a08231';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** One ABI word: what `balanceOf` returns. */
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The address's USDC balance in atomic units, or null when it could not be
 * read inside `timeoutMs`: a transport failure, a non-2xx, an RPC error, or an
 * answer that is not one word. Never throws, so the caller picks which way an
 * unreadable balance falls.
 */
export async function readUsdcBalance(
  address: string,
  rpcUrl: string,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<bigint | null> {
  if (!ADDRESS_RE.test(address) || opts.timeoutMs <= 0) return null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: USDC_ADDRESS,
            data: `${BALANCE_OF_SELECTOR}${address.slice(2).toLowerCase().padStart(64, '0')}`,
          },
          'latest',
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return null;
    const result = ((await res.json()) as { result?: unknown } | null)?.result;
    return typeof result === 'string' && WORD_RE.test(result) ? BigInt(result) : null;
  } catch {
    return null;
  }
}

/** Base's public RPC: the shipped `rpcUrl` default (`CONFIG_DEFAULTS`). */
export const DEFAULT_RPC_URL = 'https://mainnet.base.org';

/**
 * Public Base RPCs a balance read on the DEFAULT `rpcUrl` falls back to, in
 * order, only after it fails. mainnet.base.org rate-limits a busy IP
 * (`-32016 over rate limit`): four paid lookups across two research runs were
 * refused with `balance_unavailable` before signing, while these two answered
 * every read. They see the wallet's address only when the default did not
 * answer, as the default sees it on every read.
 */
export const FALLBACK_RPC_URLS: readonly string[] = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
];

/**
 * {@link readUsdcBalance} from `rpcUrl` first and, when that is the default,
 * then from each of {@link FALLBACK_RPC_URLS} until one answers, all inside the
 * one `timeoutMs`. Every RPC but the last gets half of what is left, so one
 * that hangs still leaves the others time to answer.
 *
 * AN RPC THE USER CONFIGURED IS THE ONLY ONE ASKED. Choosing one can be about
 * privacy, and the public RPCs would see the wallet's address; a read that
 * fails there fails, as it did before the fallbacks.
 */
export async function readUsdcBalanceWithFallback(
  address: string,
  rpcUrl: string,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<bigint | null> {
  const urls = sameUrl(rpcUrl, DEFAULT_RPC_URL) ? [rpcUrl, ...FALLBACK_RPC_URLS] : [rpcUrl];
  const deadline = Date.now() + opts.timeoutMs;
  for (const [index, url] of urls.entries()) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const timeoutMs = index === urls.length - 1 ? left : Math.ceil(left / 2);
    const balance = await readUsdcBalance(address, url, { ...opts, timeoutMs });
    if (balance !== null) return balance;
  }
  return null;
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}
