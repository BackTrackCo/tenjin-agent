import type { Answer, Leg, LegResult } from '../types';

/**
 * A leg over this machine's own `loop.db` (13-pr-d-local-arms.md): the handoff
 * a dispatch parked for a starting child. It resolves at once with
 * `status: 'ok'`, so a parked answer flows through the kernel exactly like a
 * shelf answer — one `legs` row, `delivered`, the actor's own `seen:` mark, the
 * same `deliver()` — and a miss here is a definite one (`no-hit`, cached),
 * never a `no-answer`.
 *
 * `shelf` is the parked answer's own (a parked public piece is still a public
 * piece), and the caller's default when the claim found nothing.
 */
export function localLeg(shelf: Answer['shelf'], read: () => Answer | null): Leg {
  return {
    shelf,
    async request(): Promise<LegResult> {
      const answer = read();
      return {
        status: 'ok',
        ...(answer?.searchId !== undefined ? { searchId: answer.searchId } : {}),
        ...(answer?.title !== undefined ? { title: answer.title } : {}),
        ...(answer?.url !== undefined ? { url: answer.url } : {}),
        ...(answer?.form !== undefined ? { form: answer.form } : {}),
        payload: answer,
      };
    },
    verdict(result: LegResult): Answer | null {
      return (result.payload as Answer | null | undefined) ?? null;
    },
  };
}
