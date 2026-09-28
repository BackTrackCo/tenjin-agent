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

export type JevgrepSupplier = typeof JEVGREP_SUPPLIER;
