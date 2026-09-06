import { teamOrigin } from '../legs/shelf';
import { PRIMER_TEXT, PRIMER_TEXT_TEAM } from '../prose';
import type { Arm } from '../types';

/**
 * The primer arm (13-pr-d-local-arms.md, "primer"): the two paragraphs in
 * front of the model at the top of a session, startup, clear and compact
 * alike. Lead-only by construction: `SessionStart` never fires for a child.
 * No lookup, no stats fetch: nothing here needs a clock.
 */
export const primerArm: Arm = {
  id: 'primer',
  wait: 'human',
  on: [{ event: 'session.start' }],
  after(ctx) {
    const cfg = ctx.deps.config();
    if (cfg.hooks.sessionPrimer !== 'on') return null;
    return { context: teamOrigin(cfg) !== null ? PRIMER_TEXT_TEAM : PRIMER_TEXT };
  },
};
