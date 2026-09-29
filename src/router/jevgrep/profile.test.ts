import { describe, expect, it } from 'vitest';
import { jevgrepProfile, jevgrepProfileForBudget, type JevgrepProfileId } from './profile';
import { JEV_LIMITS, JEV_MODEL, validateNativeRequest } from './protocol';
import { SNAPSHOT_LIMITS } from './snapshot';
describe('explicit retrieval profiles', () => {
  it('preserves standard bounds and admits only the closed opt-in extended policy', () => {
    expect(jevgrepProfileForBudget(50_000n)).toBe('standard-v1');
    expect(jevgrepProfileForBudget(50_001n)).toBe('extended-v1');
    expect(jevgrepProfileForBudget(1_000_000n)).toBe('extended-v1');
    for (const cap of [0n, -1n, 1_000_001n]) expect(() => jevgrepProfileForBudget(cap)).toThrow();
    expect(() => jevgrepProfile('unlimited' as JevgrepProfileId)).toThrow();
    expect(JEV_LIMITS).toEqual({
      concurrency: 2,
      requests: 60,
      localRequests: 4096,
      localRequestBytes: 67108864,
      requestBytes: 131072,
      totalRequestBytes: 2097152,
      responseBytes: 262144,
      outputBytes: 16384,
    });
    expect(SNAPSHOT_LIMITS).toEqual({ files: 512, fileBytes: 131072, totalBytes: 8388608 });
    const extended = jevgrepProfile('extended-v1');
    expect(extended).toMatchObject({
      maxRunAtomic: 1_000_000n,
      searchTimeoutMs: 900000,
      sourceBytes: 16384,
      snapshot: { fileBytes: 262144 },
      limits: {
        requests: 1000,
        concurrency: 2,
        requestBytes: 262144,
        totalRequestBytes: 67108864,
        outputBytes: 32768,
      },
    });
    expect(Object.isFrozen(extended.limits)).toBe(true);
  });
  it('accepts larger native input only under the explicit extended profile', () => {
    const request = {
      model: JEV_MODEL,
      state: 'x'.repeat(160000),
      questions: { q: { type: 'noul', instructions: 'Relevant?' } },
    };
    expect(() => validateNativeRequest(request)).toThrow();
    expect(validateNativeRequest(request, 'extended-v1')).toEqual(request);
    expect(() =>
      validateNativeRequest({ ...request, state: 'x'.repeat(262144) }, 'extended-v1'),
    ).toThrow();
  });
});
