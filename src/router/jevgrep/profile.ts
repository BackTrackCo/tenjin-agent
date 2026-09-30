/** Closed, versioned policies. A grant above the legacy cap opts into extended retrieval. */
const standardLimits = Object.freeze({
  // Measured against the Maple supplier on 2026-09-30: 16 in flight gave a 2.5 s
  // median and 3.3 evaluations/s; 32 gave a 7.6 s median, dropped connections
  // and lower throughput. The proxy answers 429 above this.
  concurrency: 16,
  requests: 60,
  localRequests: 4096,
  localRequestBytes: 64 * 1024 * 1024,
  requestBytes: 128 * 1024,
  totalRequestBytes: 2 * 1024 * 1024,
  responseBytes: 256 * 1024,
  outputBytes: 16 * 1024,
});
const standardSnapshot = Object.freeze({
  files: 512,
  fileBytes: 128 * 1024,
  totalBytes: 8 * 1024 * 1024,
});
const profiles = Object.freeze({
  'standard-v1': Object.freeze({
    id: 'standard-v1' as const,
    maxRunAtomic: 50_000n,
    limits: standardLimits,
    snapshot: standardSnapshot,
    searchTimeoutMs: 60_000,
    sourceBytes: 16 * 1024,
  }),
  'extended-v1': Object.freeze({
    id: 'extended-v1' as const,
    maxRunAtomic: 1_000_000n,
    limits: Object.freeze({
      ...standardLimits,
      requests: 1000,
      requestBytes: 256 * 1024,
      totalRequestBytes: 64 * 1024 * 1024,
      outputBytes: 32 * 1024,
    }),
    snapshot: Object.freeze({ ...standardSnapshot, fileBytes: 256 * 1024 }),
    searchTimeoutMs: 900_000,
    sourceBytes: 16 * 1024,
  }),
});
export type JevgrepProfileId = keyof typeof profiles;
export function jevgrepProfile(id: JevgrepProfileId = 'standard-v1') {
  if (id !== 'standard-v1' && id !== 'extended-v1') throw new Error('Invalid retrieval profile');
  return profiles[id];
}
export function jevgrepProfileForBudget(amount: bigint): JevgrepProfileId {
  if (amount <= 0n || amount > profiles['extended-v1'].maxRunAtomic)
    throw new Error('Invalid retrieval budget');
  return amount > profiles['standard-v1'].maxRunAtomic ? 'extended-v1' : 'standard-v1';
}
