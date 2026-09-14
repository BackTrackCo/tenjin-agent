import type { HookTool } from '../../adapters/types';
import { deliver } from '../deliver';
import { failureQuestionKey, SIG_LABEL, TEST_SIG_LABEL } from '../failure/keys';
import {
  allowedHeads,
  errorLine,
  sigV1,
  type ErrorLine,
  type Signature,
} from '../failure/signature';
import { sigV1Test, testIdentityOf, type TestSignature } from '../failure/test-identity';
import { getMark } from '../gates';
import { keysLeg, searchLeg, teamOrigin } from '../legs/shelf';
import { question } from '../question';
import { stripAnsi } from '../text';
import type { Arm, Leg, Question } from '../types';
import { BASH_START } from './context';

/**
 * The failure arm (13-pr-d-local-arms.md, "failure"). An agent's command
 * fails, and the arm asks about it in two rounds.
 *
 * ROUND ONE IS THE FINGERPRINTS: the team shelf's keys, under the failure's
 * `sig_v1` and `sig_v1_test`, both sent in the one resolve request so the
 * server picks between them.
 *
 * ROUND TWO ASKS THE SAME SHELF IN WORDS, with the error line as the runner
 * printed it, and runs only when round one answered nothing (`ask.ts` stops at
 * the first stage that answers). A key resolves a failure somebody already
 * published a key for; the write-up a teammate wrote about the same error in
 * prose carries no fingerprint at all, and used to be unreachable from here.
 * A fingerprint that DID resolve has already named this exact failure, so
 * words after it could only be vaguer, which is why the rounds are ordered and
 * not merged.
 *
 * THE TEAM SHELF IS THE ONLY ONE ASKED, in either round. There is no public
 * leg: the marketplace holds none of this team's errors, and every hit in a
 * 150-search census of this shelf came from the team side.
 *
 * THE ARM ONLY ASKS. It writes nothing about the failure, so a fire that finds
 * nothing leaves its ledger row and no other trace. That row IS the record: it
 * already carries the composed question key and the masked line, which is what
 * the turn-end ask reads back to name the failure (`capture.ts`), so there is
 * no second store to keep in step with it.
 *
 * `tool.ok` is `decode`'s: false on `PostToolUseFailure` and on a Bash
 * `PostToolUse` whose output carries an error marker (decision 9). The arm
 * never reads text to decide WHETHER something failed, only WHAT.
 */

function commandOf(tool: HookTool | undefined): string {
  return tool?.kind === 'shell' ? tool.command : '';
}

/** Both streams, and the failure string a `PostToolUseFailure` carries. A
 *  runner prints its verdict to STDOUT with an empty stderr. */
function failureText(tool: HookTool | undefined): string {
  const r = tool?.result;
  // COLOUR COMES OFF HERE, ONCE, because everything downstream reads this text
  // by line and every marker that recognizes a diagnostic line is anchored to
  // the start of it. A pty or `FORCE_COLOR` puts an SGR sequence in front of
  // `Error:`, `npm ERR!`, `panic:`, `fatal:` and vitest's own ` FAIL <file> >
  // <test>` header, and the scanner walks past all of them: `errorLine` then
  // keys the failure on whatever unanchored marker it finds further down (a
  // `FAIL` header, or `exit code 128`), `testIdentityOf`'s console fallback
  // finds no header, and whatever line does survive carries `[31m` onto the
  // wire, since `mask` deletes the escape byte and leaves the rest.
  return stripAnsi(
    [r?.stdout, r?.stderr, r?.error, r?.text]
      .filter((t): t is string => typeof t === 'string')
      .join('\n'),
  );
}

/**
 * What this failure asks, or null when it has nothing to ask with.
 *
 * THE TEXT IS THE ERROR LINE as the runner printed it, through the same
 * `question()` every other arm goes through: masked, and nothing else. That is
 * what makes the text round possible at all.
 *
 * THE KEY IS NOT THE TEXT'S. `question()` keys on the line alone, and the line
 * alone is the same bytes for a TypeError in `a.ts` and the identical TypeError
 * in `b.ts`. Those are two failures, and under one key the second takes the
 * first's cached miss out of the once-per-question gate (`gates.ts`,
 * `Q_PREFIX`) and is never looked up — a real fingerprint sitting right there,
 * unasked. So the key composes every fingerprint this failure HAS with the hash
 * of its line ({@link failureQuestionKey}), and the line hash is the tiebreak
 * of last resort.
 *
 * With no error line there is still a test identity, which has nothing to say
 * in words but a key the resolve leg answers exactly; the composed key is then
 * that fingerprint alone. THERE IS NO EMPTY FALLBACK: a key of `''` would file
 * every keyless failure on this machine under one claim, so the first one asked
 * would answer — and then silence — all the others for the life of the session.
 * Null is the arm having nothing at all, which is a `no-question` row and
 * claims nothing.
 */
function questionOf(
  found: ErrorLine | null,
  sig: Signature | null,
  testSig: TestSignature | null,
): Question | null {
  const asked = found === null ? null : question(found.line);
  const questionKey = failureQuestionKey({
    ...(sig !== null ? { sig: sig.key } : {}),
    ...(testSig !== null ? { testSig: testSig.key } : {}),
    ...(asked !== null ? { lineKey: asked.questionKey } : {}),
  });
  if (questionKey === '') return null;
  return { text: asked?.text ?? '', questionKey };
}

export const failureArm: Arm = {
  id: 'failure',
  wait: 'tool',
  on: [{ event: 'tool.after', kind: 'shell' }],

  async plan(ctx) {
    const cfg = ctx.deps.config();
    if (!cfg.hooks.failure) return null;
    // Both rounds go to a team origin or nowhere: there is no public resolve,
    // and no public leg by decision. A machine with no team shelf therefore has
    // nothing to ask however the failure reads, and asking that here is what
    // keeps it from paying for the test-report read below to learn it.
    if (teamOrigin(cfg) === null) return null;
    const tool = ctx.input.tool;
    if (tool?.ok !== false) return null;
    const command = commandOf(tool);
    if (allowedHeads(command).length === 0) return null;
    const { db } = ctx.deps;
    const cwd = ctx.input.cwd;
    const text = failureText(tool);
    const found = errorLine(text);
    const sig = found === null ? null : sigV1(found.line, found.block);
    // The context arm's stamp for THIS call, so a report from the run before
    // it cannot be read as this run's. No stamp, no artifact leg: `Number(null)`
    // is 0, which would accept any report ever written.
    const stamp = getMark(db, ctx.actor, BASH_START);
    const since = stamp === null ? Number.NaN : Number(stamp);
    const identity = await testIdentityOf(
      text,
      cwd,
      Number.isFinite(since) ? since : null,
      command,
    );
    const testSig = identity === null ? null : sigV1Test(identity);
    // The give-up is "nothing to ask", not "no fingerprint". A failure whose
    // line is real but too generic to key — no errno, no frame, so `sigV1`
    // refuses it — is still a sentence a teammate may have written about, and
    // the text round is what reaches that write-up.
    const q = questionOf(found, sig, testSig);
    if (q === null) return null;

    // The same two labels the composed key carries, off the same constants, so
    // the form on the wire and the form the ask reads back cannot drift.
    const fine: string[] = [];
    if (sig !== null) fine.push(SIG_LABEL + ':' + sig.key);
    if (testSig !== null) fine.push(TEST_SIG_LABEL + ':' + testSig.key);
    // A resolve with no keys in it is a request that can only answer nothing,
    // so it is not sent; the text round is what a keyless failure has instead.
    const stages: Leg[][] = [];
    if (fine.length > 0) stages.push([keysLeg(cfg, fine)]);
    if (q.text.length > 0) stages.push([searchLeg('team', 'failure', cfg)]);
    // A plan with no stage in it would run no leg and still be filed as a
    // `no-hit` fire: a miss the ledger records against a shelf nothing was ever
    // asked. Null is the honest `no-question` instead.
    if (stages.length === 0) return null;
    return { question: q, stages };
  },

  deliver(answer) {
    return deliver(answer, answer.shelf);
  },
};
