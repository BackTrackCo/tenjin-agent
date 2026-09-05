import type { Emit, HookInput } from '../../adapters/types';
import { deliver } from '../deliver';
import { searchLeg } from '../legs/search';
import { question, skipText } from '../question';
import type {
  Arm,
  Delivery,
  FireContext,
  KernelConfig,
  Outcome,
  Plan,
  Skip,
  SkipReason,
  Trigger,
  Wait,
} from '../types';

/**
 * The one lookup factory (09-pr-c-lookup-arms.md, "The shape of the code").
 *
 * EVERY LOOKUP ARM IS THE SAME PIPELINE WITH DIFFERENT DATA:
 *
 *   enabled? -> text -> skip? -> shape -> question -> gates -> legs -> deliver
 *
 * so the arm files are specs and this is the only place the pipeline is spelled
 * out. Adding a lookup arm in PR D (dispatch, the subagent-stop report lookup)
 * is a spec, not code. A non-lookup arm — failure, stop, primer — implements
 * `Arm` directly; this is the lookup shape, not a framework.
 */

export interface LookupSpec {
  /** The `fires.arm` key, and the ledger's name for this arm. */
  id: string;
  wait: Wait;
  on: Arm['on'];
  /**
   * The wire `trigger`. It is a FUNCTION of the input for the one spec whose
   * `on` list covers two different questions: the context arm answers a Read
   * with `read` and the fourth edit of a file with `churn`, and they are one
   * arm because they share every other field.
   */
  trigger: Trigger | ((input: HookInput) => Trigger);
  /** `hooks.push`, `hooks.webSearch`. A disabled arm does nothing at all. */
  enabled(cfg: KernelConfig): boolean;
  /**
   * Where the words come from. `ctx` is the second parameter because the
   * context arm's question IS its marks — the first import this actor has not
   * asked about, the fourth edit of one file — and a mark is per actor, which
   * only the fire knows. Every other spec reads `input` alone.
   */
  text(input: HookInput, ctx: FireContext): string | null;
  /** The prompt arm's junk rules, and no one else's. */
  skip?(text: string): SkipReason | null;
  /** `[mask]` or `[mask, condense]`; the list IS the behaviour, in order. */
  shape: Array<(text: string) => string>;
  /**
   * One stage, run in parallel. Never `keys`: that shelf answers a different
   * question with a different leg (the failure arm's, PR D).
   * `ask.ts` drops the public leg under `team.publicFallback: off`.
   */
  shelves: Array<'team' | 'public'>;
  deliver: 'inject' | 'log';
  /** Local writes, before anything is asked (the context arm's marks). */
  before?(ctx: FireContext): void;
  /** A local line with no lookup behind it (research's `remind`). */
  after?(ctx: FireContext, result: Outcome): Emit | null;
}

/**
 * Turn a spec into the kernel's `Arm`.
 *
 * `enabled` gates `before` too: an arm that is off is off, and marks are as
 * much of its behaviour as questions are. Text of length zero is `null` and
 * not a skip — a skip means the arm HAD words and refused them, which is the
 * distinction the ledger's four skip reasons exist to keep.
 */
export function lookupArm(spec: LookupSpec): Arm {
  const arm: Arm = {
    id: spec.id,
    wait: spec.wait,
    on: spec.on,
    plan(ctx: FireContext): Plan | Skip | null {
      const cfg = ctx.deps.config();
      if (!spec.enabled(cfg)) return null;
      const raw = spec.text(ctx.input, ctx);
      if (raw === null || raw.length === 0) return null;
      const reason = spec.skip?.(raw) ?? null;
      // A skipped row still lands in `loop.db`, so it carries the SCRUBBED head,
      // never the raw text: `long` is by definition a 4000-character paste, and
      // a paste is where a token and another session's transcript live.
      if (reason !== null) return { reason, text: skipText(raw) };
      const q = question(raw, spec.shape);
      if (q.text.length === 0) return null;
      const trigger = typeof spec.trigger === 'function' ? spec.trigger(ctx.input) : spec.trigger;
      return { question: q, stages: [spec.shelves.map((s) => searchLeg(s, trigger, cfg))] };
    },
    /**
     * `log` is a real delivery, not a missing one: the arm looked something up
     * to earn a precision number and says nothing. The kernel still writes the
     * row, and it does NOT burn the once-per-piece mark — nothing was shown, so
     * the prompt arm may still inject that piece a second later (`fire.ts`).
     */
    deliver(answer): Delivery {
      return spec.deliver === 'log'
        ? { mode: 'log', resourceId: answer.resourceId }
        : deliver(answer, answer.shelf);
    },
  };
  if (spec.before !== undefined) {
    const before = spec.before;
    arm.before = (ctx) => {
      if (spec.enabled(ctx.deps.config())) before(ctx);
    };
  }
  if (spec.after !== undefined) arm.after = spec.after;
  return arm;
}
