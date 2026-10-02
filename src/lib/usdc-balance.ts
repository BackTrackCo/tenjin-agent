/**
 * Base USDC's address and one `balanceOf` over plain JSON-RPC. No viem on
 * purpose: the router hooks read a balance before they redirect a call, and
 * their chunk graph must stay free of it (`src/router/dist-chunks.test.ts`).
 * One `eth_call` needs nothing viem adds. `usdc.ts` keeps the viem client for
 * the send path and re-exports the address from here.
 */

import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-json';
import { balanceCachePath } from './paths';

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

/**
 * How long the hooks remember a balance read. Base's public RPC refuses the
 * sixth `eth_call` in a second, which a burst of parallel lookups reaches, and
 * each hook then waited on a failed read. A minute carries a burst past that;
 * the hooks' read only decides whether to offer.
 */
export const LAST_KNOWN_BALANCE_MS = 60_000;

/**
 * {@link readUsdcBalance} for the router hooks, which returns the last read it
 * made for this address while it is under {@link LAST_KNOWN_BALANCE_MS} old,
 * without asking the RPC, and reads the chain otherwise. A read that fails is
 * null, never the remembered balance. The RPC URL is never stored, since it
 * can embed a key.
 *
 * NEVER FOR A PAYMENT. `tenjin pay` reads the signer's balance live
 * immediately before signing (docs/agent-permissions.md): a minute-old balance
 * can be one the wallet has since spent.
 */
export function rememberingBalanceReader(
  dataDir: string,
  opts: { now?: () => number; read?: typeof readUsdcBalance } = {},
): typeof readUsdcBalance {
  const read = opts.read ?? readUsdcBalance;
  const now = opts.now ?? Date.now;
  const path = balanceCachePath(dataDir);
  return async (address, rpcUrl, readOpts) => {
    const remembered = await recallBalance(path, address, now());
    if (remembered !== null) return remembered;
    const live = await read(address, rpcUrl, readOpts);
    if (live === null) return null;
    const record = {
      version: 1,
      address: address.toLowerCase(),
      atomic: live.toString(),
      at: now(),
    };
    try {
      await writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, dirMode: 0o700 });
    } catch {
      // A cache that cannot be written is a cache that is not used.
    }
    return live;
  };
}

/** The remembered balance for this address while it is fresh, else null. */
async function recallBalance(path: string, address: string, now: number): Promise<bigint | null> {
  try {
    const row = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> | null;
    if (
      row?.version !== 1 ||
      row.address !== address.toLowerCase() ||
      typeof row.atomic !== 'string' ||
      !/^\d{1,40}$/.test(row.atomic) ||
      typeof row.at !== 'number' ||
      now - row.at < 0 ||
      now - row.at > LAST_KNOWN_BALANCE_MS
    ) {
      return null;
    }
    return BigInt(row.atomic);
  } catch {
    return null;
  }
}
