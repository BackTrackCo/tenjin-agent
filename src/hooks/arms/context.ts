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
 *  - `edited:<pathKey>`, its close rule, with the path as the value;
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

const BASH_START = 'bashstart';
const EDITED_PREFIX = 'edited:';
const ACTIVITY_PREFIX = 'activity:';

function filePathOf(ctx: FireContext): string {
  const value = ctx.input.tool?.input.file_path;
  return typeof value === 'string' && value.length <= 4096 ? value : '';
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
   * EVERY edited path is marked whatever its extension: the close rule asks
   * "did a tracked file change since this pairing opened", and a hook cannot
   * ask git that in front of a tool call.
   */
  before(ctx) {
    const { db, clock } = ctx.deps;
    // An arm that is off is off, marks included.
    if (ctx.deps.config().hooks.push !== 'on') return;
    const kind = ctx.input.tool?.kind;
    if (kind === 'shell') {
      // One stamp per Bash call, per agent, so parallel subagents cannot
      // clobber each other's. PR D's failure arm reads it back to decide
      // whether a test report could be about THIS command.
      setMark(db, ctx.actor, BASH_START, String(clock()), clock());
      return;
    }
    const path = filePathOf(ctx);
    if (kind === 'edit' && path.length > 0) {
      // Upserted, so a re-edit moves `marks.at` and nothing else. The VALUE is
      // the path as given: the failure arm's close rule asks whether it is
      // under the checkout (tenjin-agent#269), compares its basename with the
      // files the error named, records it repo-relative, and reads the time
      // off `marks.at`.
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
