import type { Emit, HookInput } from '../../adapters/types';
import { deliver } from '../deliver';
import { searchLeg } from '../legs/shelf';
import { question, skipText } from '../question';
import type {
  Arm,
  Delivery,
  FireContext,
  KernelConfig,
  Maybe,
  Outcome,
  Plan,
  Question,
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
 *   enabled? -> text -> skip? -> question -> gates -> legs -> deliver
 *
 * so the arm files are specs and this is the only place the pipeline is spelled
 * out. Adding a lookup arm in PR D (dispatch)
 * is a spec, not code. An arm that asks nothing — context, and the failure,
 * stop and primer arms of PR D — implements `Arm` directly; this is the lookup
 * shape, not a framework.
 */

export interface LookupSpec {
  /** The `fires.arm` key, and the ledger's name for this arm. */
  id: string;
  wait: Wait;
  on: Arm['on'];
  /**
   * The wire `trigger`. It is a FUNCTION of the input for a spec whose `on` list
   * covers two moments the server's telemetry should tell apart; the arms here
   * each answer one moment and pass a constant.
   */
  trigger: Trigger | ((input: HookInput) => Trigger);
  /** `hooks.push`, `hooks.webSearch`. A disabled arm does nothing at all. */
  enabled(cfg: KernelConfig): boolean;
  /**
   * Where the words come from, as the agent wrote them: `question()` masks them
   * and nothing else touches them. `ctx` is the second parameter for a spec
   * whose text depends on this actor's own marks, which only the fire knows.
   */
  text(input: HookInput, ctx: FireContext): Maybe<string | null>;
  /** The prompt arm's junk rules, and no one else's. */
  skip?(text: string): SkipReason | null;
  /**
   * One stage, run in parallel. Never `keys`: that shelf answers a different
   * question with a different leg (the failure arm's, PR D).
   * `ask.ts` drops the public leg under `team.publicFallback: off`.
   */
  shelves: Array<'team' | 'public'>;
  /** `log` is the dispatch arm's: it parks what it found for the child and
   *  says nothing to the parent. */
  deliver: 'inject' | 'log';
  /** Local writes, before anything is asked. */
  before?(ctx: FireContext): void;
  /**
   * A local line with no lookup behind it (research's `remind`), and any local
   * write a fire has to have EARNED. `question` is the one this fire built and
   * null when it built none, so a spec marks what was asked rather than
   * re-deriving it: two parallel fires by one actor would otherwise each mark
   * the other's question.
   */
  after?(ctx: FireContext, result: Outcome, question: Question | null): Emit | null;
}

/**
 * Turn a spec into the kernel's `Arm`.
 *
 * `enabled` gates `before` and `after` too: an arm that is off is off, and
 * marks are as much of its behaviour as questions are. Text of length zero is `null` and
 * not a skip — a skip means the arm HAD words and refused them, which is the
 * distinction the ledger's three skip reasons exist to keep.
 */
export function lookupArm(spec: LookupSpec): Arm {
  const arm: Arm = {
    id: spec.id,
    wait: spec.wait,
    on: spec.on,
    plan(ctx: FireContext): Maybe<Plan | Skip | null> {
      const cfg = ctx.deps.config();
      if (!spec.enabled(cfg)) return null;
      const build = (raw: string | null): Plan | Skip | null => {
        if (raw === null || raw.length === 0) return null;
        const reason = spec.skip?.(raw) ?? null;
        // A skipped row still lands in `loop.db`, so it carries the masked head
        // and never the raw text: a refused prompt is where a pasted transcript
        // and a credential live.
        if (reason !== null) return { reason, text: skipText(raw) };
        const q = question(raw);
        if (q.text.length === 0) return null;
        const trigger = typeof spec.trigger === 'function' ? spec.trigger(ctx.input) : spec.trigger;
        return { question: q, stages: [spec.shelves.map((s) => searchLeg(s, trigger, cfg))] };
      };
      // A spec whose text is synchronous plans synchronously: the promise is
      // only ever the spec's own, so a sync spec costs no microtask.
      const raw = spec.text(ctx.input, ctx);
      return raw instanceof Promise ? raw.then(build) : build(raw);
    },
    /**
     * `log` is a real delivery, not a missing one: an arm with nobody left to
     * speak to still looked something up, and the kernel still writes the row.
     * It does NOT burn the once-per-piece mark — nothing was shown, so the
     * prompt arm may still inject that piece a second later (`fire.ts`).
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
  if (spec.after !== undefined) {
    const after = spec.after;
    arm.after = (ctx, result, question) =>
      spec.enabled(ctx.deps.config()) ? after(ctx, result, question) : null;
  }
  return arm;
}
