/** Reviewed native Jev supplier. Routing responses cannot alter these payment terms. */
export const JEVGREP_SUPPLIER = Object.freeze({
  id: 'jev-x402',
  url: 'https://jev-x402.vercel.app/jev',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0xE813d34C0525E0fBb1e6478B86D40B83603C2008',
  model: 'jev-1.13.0',
  maxAmountAtomic: '1000',
} as const);

/** Reviewed Maple per-request x402 route; no API key or prepaid account. */
export const MAPLE_JEVGREP_SUPPLIER = Object.freeze({
  id: 'maple-jev',
  url: 'https://base.mapleai.shop/jev',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x63db6eaf635a31bbc6714fe37bdc85243864f611',
  model: 'jev-latest',
  // Each request's live quote must remain within this ceiling and the run budget.
  maxAmountAtomic: '10000',
} as const);

export type JevgrepSupplier = typeof JEVGREP_SUPPLIER | typeof MAPLE_JEVGREP_SUPPLIER;

export function jevgrepSupplier(id: JevgrepSupplier['id']): JevgrepSupplier {
  return id === 'maple-jev' ? MAPLE_JEVGREP_SUPPLIER : JEVGREP_SUPPLIER;
}
