import { createHash } from 'node:crypto';
import { setMark } from '../gates';
import { stripControl } from '../text';
import type { Arm, FireContext } from '../types';

/**
 * The context arm: marks, and nothing else (09-pr-c-lookup-arms.md).
 *
 * IT ASKS NOBODY ANYTHING. The read lookup — the first package a file you just
 * read imports — and the stuck-edit lookup — the fourth edit of one file — are
 * both gone. Each invented a question out of a file rather than carrying one an
 * agent asked, and a question this machine made up is not the loop's product
 * (owner decision 2026-09-06). A fire on this arm therefore records
 * `no-question`, which is the truth: it never had one.
 *
 * WHAT IS LEFT IS WHAT OTHER ARMS READ, all under THIS actor — which is what
 * the old code faked with an `agentKey()` prefix, and a subagent's edit is the
 * subagent's:
 *  - `bashstart`, the failure arm's test-identity clock (PR D);
 *  - `edited:<pathKey>`, the publish arm's evidence that this actor did work;
 *  - `activity:inspection` / `activity:mutation`, the capture ask's gate.
 *
 * It stays registered on the same three (event, kind) pairs because those marks
 * are stamped where the work happens.
 */

/**
 * The key the `edited:` mark is written under. A path is operator text and a
 * mark key is not a place to keep it, so the key is a HASH OF THE WHOLE PATH —
 * sha256, hex, first 16 bytes, the shape `question.ts` keys a question on.
 *
 * OF THE WHOLE PATH, because a tail is not a file: two deep paths under
 * different roots share their last 200 characters often enough in a monorepo.
 */
function pathKey(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32);
}

/** The marks this arm writes and the failure and capture arms read back. */
export const BASH_START = 'bashstart';
export const EDITED_PREFIX = 'edited:';
const ACTIVITY_PREFIX = 'activity:';

/** Every path the edit names, bounded; an adapter that found none leaves nothing to mark. */
function editedPaths(ctx: FireContext): string[] {
  const tool = ctx.input.tool;
  if (tool?.kind !== 'edit') return [];
  return tool.paths.filter((p) => p.length > 0 && p.length <= 4096);
}

export const contextArm: Arm = {
  id: 'context',
  wait: 'tool',
  on: [
    { event: 'tool.before', kind: 'edit' },
    { event: 'tool.before', kind: 'shell' },
    { event: 'tool.after', kind: 'read' },
  ],
  /**
   * EVERY edited path is marked whatever its extension: the reader asks "did
   * this actor edit anything at all" (`capture.ts`, `hasMark(db, actor,
   * EDITED_PREFIX)`, the publish arm's `edited` evidence), and a hook cannot
   * ask git that in front of a tool call.
   */
  before(ctx) {
    const { db, clock } = ctx.deps;
    // Bookkeeping for the failure and publish arms — the shell stamp is the
    // failure arm's, the edit marks are the publish arm's evidence test — so it
    // runs while either is on and stops when both are off.
    const { hooks } = ctx.deps.config();
    if (!hooks.failure && !hooks.publish) return;
    const kind = ctx.input.tool?.kind;
    if (kind === 'shell') {
      // One stamp per Bash call, per agent, so parallel subagents cannot
      // clobber each other's. PR D's failure arm reads it back to decide
      // whether a test report could be about THIS command.
      setMark(db, ctx.actor, BASH_START, String(clock()), clock());
      return;
    }
    // One mark per path, all in this fire: a patch that touches three files is
    // one native call and one row, and every file it named is attempted work.
    // Upserted, so a re-edit moves `marks.at` and nothing else. NOTHING READS
    // THE VALUE: the one reader asks whether this actor edited anything at all
    // (`capture.ts`, `hasMark(db, actor, EDITED_PREFIX)`, the publish arm's
    // `edited` evidence), and the key answers that by itself. The path is kept
    // because the key is a one-way hash, so a row an operator opens on their
    // own machine would otherwise say nothing about which file it stands for.
    for (const path of editedPaths(ctx)) {
      setMark(db, ctx.actor, EDITED_PREFIX + pathKey(path), stripControl(path), clock());
    }
    // Content-free, and the LEAD's only: one mark for inspection and one for
    // mutation, never the path, the tool input or a growing counter. Subagent
    // work is captured at its own boundary and must not make the parent
    // eligible here.
    if (ctx.actor.agent === '') {
      const activity = ctx.input.event === 'tool.after' ? 'inspection' : 'mutation';
      setMark(db, ctx.actor, ACTIVITY_PREFIX + activity, String(clock()), clock());
    }
  },
};
