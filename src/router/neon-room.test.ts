import { expect, it } from 'vitest';
import { neonRoom, neonShortfall, type NeonLimits } from './neon-room';

const CAP = 500_000n;
const limits = (over: Partial<NeonLimits> = {}): NeonLimits => ({
  perCallAtomic: 20_000n,
  dayLeftAtomic: null,
  depositCapAtomic: CAP,
  ...over,
});

// Failure caught by review (the example, with its exact numbers): the grant filled the job's
// missing budget, and the call needed enough UNUSED approval to cover all of it. After a call that
// charged less than its voucher ceiling the two differ, and an approved revision still failed.
it('sizes a grant against the job budget and the unused approval together (limit 0.02, 0.13 granted, a 0.13 voucher charged at 0.06, a revision of 0.15)', () => {
  // The job's own ceiling is the 0.02 limit; 0.13 was granted and the 0.13 voucher spent all of
  // that approval, though the seller charged 0.06: the job has 0.02 + 0.13 - 0.06 = 0.09 left.
  const job = { jobLeftAtomic: 90_000n, approvedLeftAtomic: 0n };
  expect(neonRoom(limits(), job).room).toBe(20_000n);
  const missing = neonShortfall(150_000n, limits(), job);
  // The grant that covers the job budget alone (0.06) is not enough: the call needs 0.15 of
  // approval, and the grant adds to both.
  expect(missing).toMatchObject({ grantAtomic: 150_000n });
  const after = { jobLeftAtomic: 90_000n + 150_000n, approvedLeftAtomic: 150_000n };
  expect(neonShortfall(150_000n, limits(), after)).toBeNull();
});

it('lets a call that fits the limits through, and asks about one over any single limit', () => {
  const job = { jobLeftAtomic: 100_000n, approvedLeftAtomic: 0n };
  expect(neonShortfall(20_000n, limits(), job)).toBeNull();
  // Over the per-call limit.
  expect(neonShortfall(30_000n, limits(), job)).toMatchObject({ grantAtomic: 30_000n });
  // Over what the day has left, though under the per-call limit.
  const tight = neonShortfall(15_000n, limits({ dayLeftAtomic: 5_000n }), job);
  expect(tight).toMatchObject({ grantAtomic: 15_000n });
  expect(tight && 'why' in tight && tight.why).toContain("today's automatic budget");
  // Over the job's own budget only.
  const short = neonShortfall(15_000n, limits({ perCallAtomic: 1_000_000n }), {
    jobLeftAtomic: 10_000n,
    approvedLeftAtomic: 0n,
  });
  expect(short).toMatchObject({ grantAtomic: 5_000n });
});

it('refuses outright what no channel could hold', () => {
  expect(
    neonShortfall(600_000n, limits({ perCallAtomic: 2_000_000n }), {
      jobLeftAtomic: 9_000_000n,
      approvedLeftAtomic: 0n,
    }),
  ).toEqual({ impossible: true });
});

// A later call does not ride on an old approval: once it is spent, the room is the limits again.
it('goes back to the limits once the approval is spent, and counts the approval only while it lasts', () => {
  const job = (approvedLeftAtomic: bigint) => ({ jobLeftAtomic: 400_000n, approvedLeftAtomic });
  expect(neonRoom(limits(), job(150_000n))).toEqual({ room: 150_000n, approved: true });
  expect(neonRoom(limits(), job(0n))).toEqual({ room: 20_000n, approved: false });
  // The day's budget is lifted by an approval too, and returns with it.
  expect(neonRoom(limits({ dayLeftAtomic: 3_000n }), job(150_000n)).room).toBe(150_000n);
  expect(neonRoom(limits({ dayLeftAtomic: 3_000n }), job(0n)).room).toBe(3_000n);
});
