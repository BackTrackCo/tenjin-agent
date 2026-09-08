import { basename } from 'node:path';
import type { HookTool } from '../../adapters/types';
import { mask } from '../../lib/redact';
import { deliver } from '../deliver';
import { projectId } from '../failure/keys';
import {
  closeOpenPairings,
  findPairing,
  openPairing,
  pairingAnswer,
  pairingIdOf,
  rememberReplay,
} from '../failure/pairings';
import {
  allowedHeads,
  errorLine,
  filesInError,
  sigV1,
  type ErrorLine,
  type Signature,
} from '../failure/signature';
import { sigV1Test, testIdentityOf, type TestSignature } from '../failure/test-identity';
import { getMark } from '../gates';
import { localLeg } from '../legs/local';
import { keysLeg, searchLeg, teamOrigin } from '../legs/shelf';
import { question } from '../question';
import type { Arm, FireContext, Leg, Question } from '../types';
import { BASH_START } from './context';

/**
 * The failure arm (13-pr-d-local-arms.md, "failure"). An agent's command
 * fails, and the arm asks about it in two rounds.
 *
 * ROUND ONE IS THE FINGERPRINTS: this machine's own error-to-fix record and
 * the team shelf's keys, both under the failure's `sig_v1` and `sig_v1_test`,
 * the teammate's piece first and the local record as the fallback (decision
 * 13).
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
 * Else a pairing opens so this agent's next passing run can close it, and a
 * pass closes whatever this agent had open on the same head under the #269
 * rule.
 *
 * `tool.ok` is `decode`'s: false on `PostToolUseFailure` and on a Bash
 * `PostToolUse` whose output carries an error marker (decision 9). The arm
 * never reads text to decide WHETHER something failed, only WHAT.
 */

/** What `plan` derived, kept for `after` under the same fire: `after` must
 *  write what was ASKED, and the test-identity read is not repeatable. */
interface Failure {
  head: string;
  cwd: string;
  command: string;
  errorLine: string;
  errorFiles: string[];
  sig: Signature | null;
  testSig: TestSignature | null;
}

const planned = new WeakMap<FireContext, Failure>();

function commandOf(tool: HookTool | undefined): string {
  const command = tool?.input.command;
  return typeof command === 'string' ? command : '';
}

/** Both streams, and the failure string a `PostToolUseFailure` carries. A
 *  runner prints its verdict to STDOUT with an empty stderr. */
function failureText(tool: HookTool | undefined): string {
  const r = tool?.result;
  return [r?.stdout, r?.stderr, r?.error, r?.text]
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

/**
 * What this failure asks, or null when it has nothing to ask with.
 *
 * The error line as the runner printed it IS the question, through the same
 * `question()` every other arm goes through: masked, and keyed on its own
 * bytes. That is what makes the text round possible at all, and it is also
 * what keeps two unrelated failures apart in the once-per-question gate, which
 * the fingerprint could not — `sig_v1` normalizes a message down to 200
 * characters of shape.
 *
 * With no error line there is still a test identity, which has nothing to say
 * in words but a key the resolve leg can answer exactly. The gate is claimed
 * on that key instead. THERE IS NO EMPTY FALLBACK: a question keyed on `''`
 * would file every keyless failure on this machine under one claim
 * (`gates.ts`, `Q_PREFIX`), so the first one asked would answer — and then
 * silence — all the others for the life of the session. Null is the arm having
 * nothing at all, which is a `no-question` row and claims nothing.
 */
function questionOf(found: ErrorLine | null, testSig: TestSignature | null): Question | null {
  if (found !== null) return question(found.line);
  if (testSig !== null) return { text: '', questionKey: testSig.key };
  return null;
}

export const failureArm: Arm = {
  id: 'failure',
  wait: 'tool',
  on: [{ event: 'tool.after', kind: 'shell' }],

  /** A pass: close what this agent had open on the same head. */
  before(ctx) {
    if (!ctx.deps.config().hooks.failure) return;
    const tool = ctx.input.tool;
    if (tool?.ok !== true) return;
    const command = commandOf(tool);
    const heads = allowedHeads(command);
    if (heads.length === 0) return;
    closeOpenPairings(ctx.deps.db, ctx.actor, ctx.input.cwd, command, heads, ctx.deps.clock());
  },

  async plan(ctx) {
    const cfg = ctx.deps.config();
    if (!cfg.hooks.failure) return null;
    const tool = ctx.input.tool;
    if (tool?.ok !== false) return null;
    const command = commandOf(tool);
    const heads = allowedHeads(command);
    const head = heads[heads.length - 1];
    if (head === undefined) return null;
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
    const q = questionOf(found, testSig);
    if (q === null) return null;
    const project = projectId(cwd);
    planned.set(ctx, {
      head,
      cwd,
      command: mask(command),
      // The masked line off the question, not a second `mask` of the same
      // text: one masking path means the row and the query can never disagree
      // about what was stubbed.
      errorLine: q.text,
      errorFiles: found === null ? [] : filesInError(found.block),
      sig,
      testSig,
    });

    const local = localLeg('local', () => {
      // THE TEST KEY IS ASKED FIRST. `sig_v1_test` keys on what the runner
      // itself declared — file, suite, test — so it names one failure and no
      // other. `sig_v1` is a hash of console text, and every failure whose
      // message normalizes to the same 200 bytes collapses onto one value; if
      // it answered first, a record earned by one of those failures would be
      // replayed at all of them, on a run where the runner had already said
      // exactly which test broke.
      for (const key of [testSig?.key, sig?.key]) {
        if (key === undefined) continue;
        const match = findPairing(db, project, key);
        if (match !== null) return pairingAnswer(match);
      }
      return null;
    });
    const fine: string[] = [];
    if (sig !== null) fine.push('sig_v1:' + sig.key);
    if (testSig !== null) fine.push('sig_v1_test:' + testSig.key);
    // Both shelf legs go to a team origin or nowhere: there is no public
    // resolve, and no public leg by decision. A resolve with no keys in it is
    // a request that can only answer nothing, so it is not sent; the text
    // round is what a keyless failure has instead.
    const team = teamOrigin(cfg) !== null;
    const stages: Leg[][] = [team && fine.length > 0 ? [local, keysLeg(cfg, fine)] : [local]];
    if (team && q.text.length > 0) stages.push([searchLeg('team', 'failure', cfg)]);
    return { question: q, stages };
  },

  deliver(answer) {
    return deliver(answer, answer.shelf);
  },

  /**
   * Every local write, on any outcome but `deadline` (which never reaches
   * here). A local hit is remembered so this agent's later pass can be its
   * second closer; a shelf hit opens a pairing even with no file, so this
   * machine's later close is recorded too; anything else opens the rows the
   * failure earned. A question another fire of this actor already holds or
   * answered (`asked`, `cached`, `seen`) opened its rows then: a re-run is one
   * problem, not two.
   *
   * A FIRE MAY HAVE ASKED WITH NO FINGERPRINT AT ALL, since the text round
   * needs only an error line. There is then no key to open a row under and
   * nothing to close later, so both blocks below fall through and the fire
   * leaves the ledger row it already has and nothing else. That is the honest
   * outcome: a pairing under no key could never be found again.
   */
  after(ctx, result, question) {
    const failure = planned.get(ctx);
    if (question === null || failure === undefined) return null;
    const { db, clock } = ctx.deps;
    const now = clock();
    const answer = result.answer;
    if (answer?.shelf === 'local') {
      const id = pairingIdOf(answer.resourceId);
      if (id !== null) rememberReplay(db, ctx.actor, failure.head, id, now);
      return null;
    }
    if (result.reason === 'asked' || result.reason === 'cached' || result.reason === 'seen') {
      return null;
    }
    // A shelf answered: the keys leg in round one, or the team shelf in round
    // two. Both handed this agent somebody else's fix for THIS failure, so
    // both earn the row that its next pass closes — the case where a
    // teammate's piece actually worked is exactly the one the local record
    // must not miss.
    const post = answer?.shelf === 'keys' || answer?.shelf === 'team' ? answer : null;
    const base = {
      session: ctx.actor.session,
      cwd: failure.cwd,
      cmdHead: failure.head,
      cmd: failure.command,
      errorLine: failure.errorLine,
    };
    const opened: number[] = [];
    if (failure.sig !== null && (failure.errorFiles.length > 0 || post !== null)) {
      opened.push(
        openPairing(
          db,
          {
            ...base,
            kind: 'sig_v1',
            key: failure.sig.key,
            errorFiles: failure.errorFiles,
          },
          now,
        ),
      );
    }
    if (failure.testSig !== null) {
      opened.push(
        openPairing(
          db,
          {
            ...base,
            kind: 'sig_v1_test',
            key: failure.testSig.key,
            // The basename: the close rule compares basenames, and the key
            // already keeps the directory apart.
            errorFiles: [basename(failure.testSig.file)],
          },
          now,
        ),
      );
    }
    if (post !== null) {
      for (const id of opened) rememberReplay(db, ctx.actor, failure.head, id, now);
    }
    return null;
  },
};
