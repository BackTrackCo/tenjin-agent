/**
 * Base USDC's address and one `balanceOf` over plain JSON-RPC. No viem on
 * purpose: the router hooks read a balance before they redirect a call, and
 * their chunk graph must stay free of it (`src/router/dist-chunks.test.ts`).
 * One `eth_call` needs nothing viem adds. `usdc.ts` keeps the viem client for
 * the send path and re-exports the address from here.
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
